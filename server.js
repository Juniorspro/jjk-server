// ============================================================
// JJK 24FRAMES — Multiplayer WebSocket Server (v4)
// Features:
// - Authoritative dummies + PVP damage sync
// - Room system: pinned global rooms + user-created rooms
// - Password protection
// - ⭐ NEW: Voxel sync (bloques sacados + bloques físicos volando + persistidos)
// - ⭐ NEW: Auto-restart cada 90 min
// - ⭐ NEW: Detección de sobrecarga (RAM > 400MB o event loop lag > 1s)
// - ⭐ NEW: Persistencia local en /tmp (sobrevive crashes pero no redeploys)
// ============================================================

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const STATE_FILE = '/tmp/jjk_world_state.json';
const SAVE_INTERVAL_MS = 30_000;       // Auto-save cada 30 seg
const RESTART_INTERVAL_MS = 90 * 60 * 1000;  // Reinicio cada 90 min
const RAM_LIMIT_MB = 400;              // Alerta a 400MB (Render free tier = 512MB)
const EVENT_LOOP_LAG_LIMIT_MS = 1500;  // Si event loop laggea más de 1.5s = sobrecarga

const players = new Map();   // pid -> player
const rooms = new Map();     // roomId -> { name, isPinned, ..., voxelChanges, voxelProps }

let nextPlayerId = 1;
let nextRoomId = 1;
const PLAYER_MAX_HP = 5000;

// State versioning para invalidar archivos viejos al cambiar formato
const STATE_VERSION = 1;

// ============================================================
// Pinned rooms — created at startup, never expire
// ============================================================
const PINNED_ROOMS = [
  { id: 'global',   name: 'GLOBAL ARENA',     jp: '対戦', maxPlayers: 30 },
  { id: 'duel',     name: 'DUEL ARENA',       jp: '決闘', maxPlayers: 30 },
  { id: 'training', name: 'TRAINING GROUND',  jp: '練習', maxPlayers: 30 },
];

function makeRoom(opts){
  return {
    id: opts.id,
    name: opts.name,
    jp: opts.jp || '',
    isPinned: !!opts.isPinned,
    isPublic: opts.isPublic !== false,
    passwordHash: opts.passwordHash || null,
    players: new Set(),
    dummies: new Map(),
    nextDummyId: 1,
    maxPlayers: opts.maxPlayers || 20,
    createdAt: Date.now(),
    // ⭐ Voxel state
    voxelChanges: [],   // [{ kind:'remove', x, y, z, mat }]
    voxelProps: new Map(),  // propId -> { x, y, z, rx, ry, rz, mat, settled }
  };
}

function initPinnedRooms(){
  for (const p of PINNED_ROOMS){
    if (!rooms.has(p.id)){
      rooms.set(p.id, makeRoom({ id: p.id, name: p.name, jp: p.jp, isPinned: true, maxPlayers: p.maxPlayers }));
    }
  }
}

function genPlayerId(){ return 'p' + (nextPlayerId++); }

function genRoomCode(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  do {
    s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(s));
  return s;
}

function hashPassword(pw){
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// ============================================================
// PERSISTENCE
// ============================================================
let stateDirty = false;

function saveState(){
  if (!stateDirty) return;
  try {
    const out = {
      version: STATE_VERSION,
      savedAt: Date.now(),
      rooms: [],
    };
    for (const [rid, room] of rooms){
      // Solo persistir info de mundo, NO jugadores conectados ni dummies en vivo
      out.rooms.push({
        id: room.id,
        name: room.name,
        jp: room.jp,
        isPinned: room.isPinned,
        isPublic: room.isPublic,
        passwordHash: room.passwordHash,
        maxPlayers: room.maxPlayers,
        createdAt: room.createdAt,
        voxelChanges: (room.voxelChanges || []).slice(-3000),  // cap
        voxelProps: Array.from((room.voxelProps || new Map()).entries()).slice(-1000),
      });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(out));
    stateDirty = false;
    // log silencioso (no spam)
  } catch (e){
    console.error('[save] error:', e.message);
  }
}

function loadState(){
  try {
    if (!fs.existsSync(STATE_FILE)){
      console.log('[load] No existing state file');
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (data.version !== STATE_VERSION){
      console.log('[load] State version mismatch, ignoring');
      return;
    }
    const ageHours = (Date.now() - (data.savedAt || 0)) / 3600000;
    console.log(`[load] State age: ${ageHours.toFixed(1)}h`);
    for (const r of (data.rooms || [])){
      const room = makeRoom({
        id: r.id,
        name: r.name,
        jp: r.jp,
        isPinned: r.isPinned,
        isPublic: r.isPublic,
        passwordHash: r.passwordHash,
        maxPlayers: r.maxPlayers,
      });
      room.createdAt = r.createdAt || Date.now();
      room.voxelChanges = r.voxelChanges || [];
      room.voxelProps = new Map(r.voxelProps || []);
      rooms.set(r.id, room);
    }
    console.log(`[load] Loaded ${rooms.size} rooms with persistent voxel state`);
  } catch (e){
    console.error('[load] error:', e.message);
  }
}

// Cargar al arranque, después inicializar pinned (sobrescribe si no existían)
loadState();
initPinnedRooms();

// Auto-save loop
setInterval(saveState, SAVE_INTERVAL_MS);

// ============================================================
// Voxel state helpers
// ============================================================
function pushVoxelChange(room, change){
  if (!room.voxelChanges) room.voxelChanges = [];
  if (room.voxelChanges.length >= 5000){
    room.voxelChanges.splice(0, 1000);
  }
  room.voxelChanges.push(change);
  stateDirty = true;
}

function setProp(room, propId, propData){
  if (!room.voxelProps) room.voxelProps = new Map();
  room.voxelProps.set(propId, propData);
  // Cap props a 1000 (drop más viejos)
  if (room.voxelProps.size > 1000){
    const firstKey = room.voxelProps.keys().next().value;
    room.voxelProps.delete(firstKey);
  }
  stateDirty = true;
}

// ============================================================
// HTTP server (health check + room list)
// ============================================================
const server = http.createServer((req, res) => {
  if (req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    res.end(JSON.stringify({
      status: 'ok',
      players: players.size,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      memMB,
    }));
    return;
  }
  if (req.url === '/rooms'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const list = [];
    for (const [rid, r] of rooms){
      list.push({
        id: r.id,
        name: r.name,
        jp: r.jp,
        isPinned: r.isPinned,
        isPublic: r.isPublic,
        hasPassword: !!r.passwordHash,
        playersCount: r.players.size,
        maxPlayers: r.maxPlayers,
        voxelChanges: (r.voxelChanges || []).length,
        voxelProps: (r.voxelProps || new Map()).size,
      });
    }
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ============================================================
// WebSocket server
// ============================================================
const wss = new WebSocket.Server({ server });

function sendTo(playerId, msg){
  const p = players.get(playerId);
  if (!p) return;
  try { p.ws.send(JSON.stringify(msg)); } catch(e){}
}

function broadcastToRoom(roomId, msg, exceptPid){
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const pid of room.players){
    if (pid === exceptPid) continue;
    const p = players.get(pid);
    if (p && p.ws.readyState === 1){
      try { p.ws.send(data); } catch(e){}
    }
  }
}

function joinPlayerToRoom(player, roomId){
  // Salir de sala anterior
  if (player.room){
    const prev = rooms.get(player.room);
    if (prev){
      prev.players.delete(player.id);
      broadcastToRoom(player.room, { type: 'leave', id: player.id });
    }
  }
  const room = rooms.get(roomId);
  if (!room) return false;
  if (room.players.size >= room.maxPlayers) return false;
  room.players.add(player.id);
  player.room = roomId;

  // Avisar a otros en la sala
  broadcastToRoom(roomId, {
    type: 'join',
    id: player.id,
    name: player.name,
    x: player.x, z: player.z,
    yaw: player.yaw,
    color: player.color,
  }, player.id);

  // Mandar lista de jugadores actuales al recién llegado
  const others = [];
  for (const pid of room.players){
    if (pid === player.id) continue;
    const o = players.get(pid);
    if (o) others.push({
      id: o.id, name: o.name,
      x: o.x, z: o.z, yaw: o.yaw,
      color: o.color, hp: o.hp, maxHP: o.maxHP,
    });
  }
  sendTo(player.id, { type: 'roomState', roomId, others, dummies: [] });

  // ⭐ Mandar histórico de cambios de bloques
  if (room.voxelChanges && room.voxelChanges.length > 0){
    sendTo(player.id, { type: 'voxelSync', changes: room.voxelChanges });
  }
  // ⭐ Mandar props físicos asentados
  if (room.voxelProps && room.voxelProps.size > 0){
    const propsArr = [];
    for (const [pid, p] of room.voxelProps){
      propsArr.push({ kind: 'propSettled', propId: pid, ...p });
    }
    sendTo(player.id, { type: 'voxelSync', changes: propsArr });
  }
  return true;
}

wss.on('connection', (ws) => {
  const playerId = genPlayerId();
  const player = {
    id: playerId, ws,
    name: 'Player' + playerId,
    room: null,
    x: 0, z: 0, yaw: 0, pose: 'idle',
    color: '#ffffff',
    hp: PLAYER_MAX_HP, maxHP: PLAYER_MAX_HP,
    lastSeen: Date.now(),
  };
  players.set(playerId, player);
  console.log(`[+] ${playerId} connected (${players.size} total)`);

  // Welcome
  try {
    ws.send(JSON.stringify({ type: 'welcome', id: playerId }));
  } catch(e){}

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    player.lastSeen = Date.now();

    switch (msg.type){
      case 'setName': {
        if (typeof msg.name === 'string') player.name = msg.name.slice(0, 20);
        if (typeof msg.color === 'string') player.color = msg.color.slice(0, 32);
        break;
      }
      case 'listRooms': {
        const list = [];
        for (const [rid, r] of rooms){
          list.push({
            id: r.id, name: r.name, jp: r.jp,
            isPinned: r.isPinned, isPublic: r.isPublic,
            hasPassword: !!r.passwordHash,
            playersCount: r.players.size,
            maxPlayers: r.maxPlayers,
          });
        }
        sendTo(playerId, { type: 'roomList', rooms: list });
        break;
      }
      case 'createRoom': {
        const name = String(msg.name || 'Room').slice(0, 30);
        const isPublic = msg.isPublic !== false;
        const pwHash = msg.password ? hashPassword(msg.password) : null;
        const id = genRoomCode();
        const room = makeRoom({
          id, name, jp: '部', isPublic,
          passwordHash: pwHash, maxPlayers: 20,
        });
        rooms.set(id, room);
        stateDirty = true;
        sendTo(playerId, { type: 'roomCreated', roomId: id });
        break;
      }
      case 'joinRoom': {
        const rid = String(msg.roomId || '');
        const room = rooms.get(rid);
        if (!room){
          sendTo(playerId, { type: 'joinError', error: 'Room not found' });
          break;
        }
        if (room.passwordHash && hashPassword(msg.password || '') !== room.passwordHash){
          sendTo(playerId, { type: 'joinError', error: 'Wrong password' });
          break;
        }
        if (!joinPlayerToRoom(player, rid)){
          sendTo(playerId, { type: 'joinError', error: 'Room full' });
        }
        break;
      }
      case 'leaveRoom': {
        if (player.room){
          const room = rooms.get(player.room);
          if (room){
            room.players.delete(playerId);
            broadcastToRoom(player.room, { type: 'leave', id: playerId });
          }
          player.room = null;
          sendTo(playerId, { type: 'leftRoom' });
        }
        break;
      }
      case 'state': {
        if (typeof msg.x === 'number') player.x = msg.x;
        if (typeof msg.z === 'number') player.z = msg.z;
        if (typeof msg.yaw === 'number') player.yaw = msg.yaw;
        if (typeof msg.pose === 'string') player.pose = msg.pose.slice(0, 20);
        if (player.room){
          broadcastToRoom(player.room, {
            type: 'state', id: playerId,
            x: player.x, z: player.z,
            yaw: player.yaw, pose: player.pose,
          }, playerId);
        }
        break;
      }
      case 'attack': {
        if (player.room){
          broadcastToRoom(player.room, {
            type: 'attack', id: playerId,
            kind: msg.kind, x: msg.x, z: msg.z,
          }, playerId);
        }
        break;
      }
      case 'chat': {
        if (player.room){
          const text = String(msg.text || '').slice(0, 200);
          broadcastToRoom(player.room, {
            type: 'chat', id: playerId, name: player.name, text,
          });
        }
        break;
      }
      // ⭐ VOXEL SYNC
      case 'voxelChange': {
        if (!player.room) break;
        const room = rooms.get(player.room);
        if (!room) break;
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.z !== 'number') break;

        if (msg.kind === 'remove'){
          // Bloque removido del mundo (cliente lo agarró/destruyó)
          const change = { kind: 'remove', x: msg.x, y: msg.y, z: msg.z };
          if (msg.mat) change.mat = String(msg.mat).slice(0, 20);
          pushVoxelChange(room, change);
          // Broadcast
          broadcastToRoom(player.room, {
            type: 'voxelChange', ...change,
          }, playerId);
        }
        else if (msg.kind === 'propUpdate' && msg.propId){
          // Bloque físico volando: NO se persiste (es transitorio), solo broadcast
          // (Se persistirá cuando llegue propSettled)
          broadcastToRoom(player.room, {
            type: 'voxelChange',
            kind: 'propUpdate',
            propId: String(msg.propId).slice(0, 64),
            x: msg.x, y: msg.y, z: msg.z,
            rx: msg.rx || 0, ry: msg.ry || 0, rz: msg.rz || 0,
            mat: msg.mat ? String(msg.mat).slice(0, 20) : 'stone',
          }, playerId);
        }
        else if (msg.kind === 'propSettled' && msg.propId){
          // Bloque se asentó: persistir en el mundo
          const propId = String(msg.propId).slice(0, 64);
          const propData = {
            x: msg.x, y: msg.y, z: msg.z,
            rx: msg.rx || 0, ry: msg.ry || 0, rz: msg.rz || 0,
            mat: msg.mat ? String(msg.mat).slice(0, 20) : 'stone',
          };
          setProp(room, propId, propData);
          // Broadcast a otros (que ya pueden tenerlo como prop volando, lo van a "asentar")
          broadcastToRoom(player.room, {
            type: 'voxelChange',
            kind: 'propSettled',
            propId,
            ...propData,
          }, playerId);
        }
        else if (msg.kind === 'modelSpawn' && msg.modelId && msg.modelKey){
          // Modelo GLB spawneado: persistir en el mundo
          const modelId = String(msg.modelId).slice(0, 64);
          const modelData = {
            kind: 'modelSpawn',
            modelId: modelId,
            modelKey: String(msg.modelKey).slice(0, 64),
            x: msg.x, y: msg.y, z: msg.z,
            ry: msg.ry || 0,
          };
          // Reusamos voxelChanges para los modelSpawn (se replays al joinear)
          pushVoxelChange(room, modelData);
          broadcastToRoom(player.room, {
            type: 'voxelChange',
            ...modelData,
          }, playerId);
        }
        else if (msg.kind === 'toxsamSpawn' && msg.modelId && msg.assetUrl){
          // Asset ToxSam spawneado (streaming directo, URL externa)
          const modelId = String(msg.modelId).slice(0, 64);
          const data = {
            kind: 'toxsamSpawn',
            modelId: modelId,
            assetUrl: String(msg.assetUrl).slice(0, 500),
            assetName: String(msg.assetName || 'asset').slice(0, 100),
            x: msg.x, y: msg.y, z: msg.z,
            ry: msg.ry || 0,
          };
          pushVoxelChange(room, data);
          broadcastToRoom(player.room, {
            type: 'voxelChange',
            ...data,
          }, playerId);
        }
        break;
      }
      case 'ping': {
        sendTo(playerId, { type: 'pong', t: msg.t });
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${playerId} disconnected`);
    if (player.room){
      const room = rooms.get(player.room);
      if (room){
        room.players.delete(playerId);
        broadcastToRoom(player.room, { type: 'leave', id: playerId });
      }
    }
    players.delete(playerId);
  });

  ws.on('error', () => { try { ws.close(); } catch(e){} });
});

// ============================================================
// Cleanup loop — drop dead connections
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [pid, p] of players){
    if (now - p.lastSeen > 60_000){
      console.log(`[clean] Dropping stale ${pid}`);
      try { p.ws.close(); } catch(e){}
    }
  }
}, 30_000);

// ============================================================
// ⭐ AUTO-RESTART + SOBRECARGA
// ============================================================

function restartGracefully(reason){
  console.log(`[restart] ${reason} — saving state and exiting...`);
  saveState();
  // Avisar a clientes
  for (const [pid, p] of players){
    try {
      p.ws.send(JSON.stringify({ type: 'serverRestart', reason }));
      p.ws.close();
    } catch(e){}
  }
  // Espera 1 seg para que el save termine y los closes salgan
  setTimeout(() => {
    process.exit(0);  // Render redeployará automáticamente
  }, 1000);
}

// Reinicio programado cada 90 min
setTimeout(() => {
  restartGracefully('Scheduled 90-min restart');
}, RESTART_INTERVAL_MS);

// Detección de RAM alta cada 10 seg
setInterval(() => {
  const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memMB > RAM_LIMIT_MB){
    restartGracefully(`RAM overload: ${memMB.toFixed(0)}MB > ${RAM_LIMIT_MB}MB`);
  }
}, 10_000);

// Detección de event loop lag
let lastLagCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const expected = 1000;  // este interval debería correr cada 1000ms
  const actualDelay = now - lastLagCheck;
  const lag = actualDelay - expected;
  if (lag > EVENT_LOOP_LAG_LIMIT_MS){
    restartGracefully(`Event loop lag: ${lag}ms`);
    return;
  }
  lastLagCheck = now;
}, 1000);

// SIGTERM (Render lo manda antes de matar)
process.on('SIGTERM', () => {
  console.log('[sig] SIGTERM received');
  saveState();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`JJK Multiplayer Server v4 listening on :${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check:       http://localhost:${PORT}/health`);
  console.log(`Auto-restart in ${RESTART_INTERVAL_MS / 60000} min`);
});
