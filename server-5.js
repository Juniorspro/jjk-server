// ============================================================
// JJK 24FRAMES — Sandbox Multiplayer Server (v5)
// ============================================================
// Pivot: combat removed, focused on sandbox features.
// Features:
// - Room system: pinned global rooms + user-created rooms with codes
// - Password-protected rooms
// - Player position/state sync
// - Voxel sync (block grab/destroy)
// - Physical props sync (flying blocks + settled positions)
// - GLB model spawning sync (toxsamSpawn for ALL external sources)
// - Persistence to /tmp (survives crashes, lost on Render redeploy)
// - Auto-restart every 90 minutes
// - Overload detection (RAM > 400MB or event loop lag > 1.5s → restart)
// - Chat
// ============================================================

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 8080;
const STATE_FILE = '/tmp/jjk_world_state.json';
const SAVE_INTERVAL_MS = 30_000;
const RESTART_INTERVAL_MS = 90 * 60 * 1000;
const RAM_LIMIT_MB = 400;
const EVENT_LOOP_LAG_LIMIT_MS = 1500;
const STATE_VERSION = 2;

const players = new Map();
const rooms = new Map();
let nextPlayerId = 1;

const PINNED_ROOMS = [
  { id: 'global',   name: 'GLOBAL SANDBOX',   jp: '広場', maxPlayers: 30 },
  { id: 'creative', name: 'CREATIVE WORLD',   jp: '創造', maxPlayers: 30 },
  { id: 'building', name: 'BUILDING ARENA',   jp: '建築', maxPlayers: 30 },
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
    maxPlayers: opts.maxPlayers || 20,
    createdAt: Date.now(),
    voxelChanges: [],
    voxelProps: new Map(),
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
      out.rooms.push({
        id: room.id,
        name: room.name,
        jp: room.jp,
        isPinned: room.isPinned,
        isPublic: room.isPublic,
        passwordHash: room.passwordHash,
        maxPlayers: room.maxPlayers,
        createdAt: room.createdAt,
        voxelChanges: (room.voxelChanges || []).slice(-3000),
        voxelProps: Array.from((room.voxelProps || new Map()).entries()).slice(-1000),
      });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(out));
    stateDirty = false;
  } catch (e){
    console.error('[save] error:', e.message);
  }
}

function loadState(){
  try {
    if (!fs.existsSync(STATE_FILE)){
      console.log('[load] No state file');
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (data.version !== STATE_VERSION){
      console.log('[load] Version mismatch (got ' + data.version + ', expected ' + STATE_VERSION + ')');
      return;
    }
    const ageHours = (Date.now() - (data.savedAt || 0)) / 3600000;
    console.log('[load] State age: ' + ageHours.toFixed(1) + 'h');
    for (const r of (data.rooms || [])){
      const room = makeRoom({
        id: r.id, name: r.name, jp: r.jp,
        isPinned: r.isPinned, isPublic: r.isPublic,
        passwordHash: r.passwordHash, maxPlayers: r.maxPlayers,
      });
      room.createdAt = r.createdAt || Date.now();
      room.voxelChanges = r.voxelChanges || [];
      room.voxelProps = new Map(r.voxelProps || []);
      rooms.set(r.id, room);
    }
    console.log('[load] Loaded ' + rooms.size + ' rooms with persistent state');
  } catch (e){
    console.error('[load] error:', e.message);
  }
}

loadState();
initPinnedRooms();
setInterval(saveState, SAVE_INTERVAL_MS);

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
  if (room.voxelProps.size > 1000){
    const firstKey = room.voxelProps.keys().next().value;
    room.voxelProps.delete(firstKey);
  }
  stateDirty = true;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    res.end(JSON.stringify({
      status: 'ok',
      mode: 'sandbox',
      version: 'v5',
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
        id: r.id, name: r.name, jp: r.jp,
        isPinned: r.isPinned, isPublic: r.isPublic,
        hasPassword: !!r.passwordHash,
        playersCount: r.players.size, maxPlayers: r.maxPlayers,
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

  broadcastToRoom(roomId, {
    type: 'join',
    id: player.id, name: player.name,
    x: player.x, z: player.z, yaw: player.yaw,
    color: player.color,
  }, player.id);

  const others = [];
  for (const pid of room.players){
    if (pid === player.id) continue;
    const o = players.get(pid);
    if (o) others.push({
      id: o.id, name: o.name,
      x: o.x, z: o.z, yaw: o.yaw, color: o.color,
    });
  }
  sendTo(player.id, { type: 'roomState', roomId, others, dummies: [] });

  if (room.voxelChanges && room.voxelChanges.length > 0){
    sendTo(player.id, { type: 'voxelSync', changes: room.voxelChanges });
  }
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
    lastSeen: Date.now(),
  };
  players.set(playerId, player);
  console.log('[+] ' + playerId + ' connected (' + players.size + ' total)');

  try { ws.send(JSON.stringify({ type: 'welcome', id: playerId, mode: 'sandbox' })); } catch(e){}

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
            playersCount: r.players.size, maxPlayers: r.maxPlayers,
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
        if (!room){ sendTo(playerId, { type: 'joinError', error: 'Room not found' }); break; }
        if (room.passwordHash && hashPassword(msg.password || '') !== room.passwordHash){
          sendTo(playerId, { type: 'joinError', error: 'Wrong password' }); break;
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
      case 'role': break;  // Sandbox: ignored, accepted for compat
      case 'skin': {
        if (player.room){
          broadcastToRoom(player.room, {
            type: 'skin', id: playerId, skinId: msg.skinId,
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
      case 'voxelChange': {
        if (!player.room) break;
        const room = rooms.get(player.room);
        if (!room) break;
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.z !== 'number') break;

        if (msg.kind === 'remove'){
          const change = { kind: 'remove', x: msg.x, y: msg.y, z: msg.z };
          if (msg.mat) change.mat = String(msg.mat).slice(0, 20);
          pushVoxelChange(room, change);
          broadcastToRoom(player.room, { type: 'voxelChange', ...change }, playerId);
        }
        else if (msg.kind === 'propUpdate' && msg.propId){
          broadcastToRoom(player.room, {
            type: 'voxelChange', kind: 'propUpdate',
            propId: String(msg.propId).slice(0, 64),
            x: msg.x, y: msg.y, z: msg.z,
            rx: msg.rx || 0, ry: msg.ry || 0, rz: msg.rz || 0,
            mat: msg.mat ? String(msg.mat).slice(0, 20) : 'stone',
          }, playerId);
        }
        else if (msg.kind === 'propSettled' && msg.propId){
          const propId = String(msg.propId).slice(0, 64);
          const propData = {
            x: msg.x, y: msg.y, z: msg.z,
            rx: msg.rx || 0, ry: msg.ry || 0, rz: msg.rz || 0,
            mat: msg.mat ? String(msg.mat).slice(0, 20) : 'stone',
          };
          setProp(room, propId, propData);
          broadcastToRoom(player.room, {
            type: 'voxelChange', kind: 'propSettled', propId, ...propData,
          }, playerId);
        }
        else if (msg.kind === 'modelSpawn' && msg.modelId && msg.modelKey){
          const modelId = String(msg.modelId).slice(0, 64);
          const modelData = {
            kind: 'modelSpawn', modelId,
            modelKey: String(msg.modelKey).slice(0, 64),
            x: msg.x, y: msg.y, z: msg.z,
            ry: msg.ry || 0,
          };
          pushVoxelChange(room, modelData);
          broadcastToRoom(player.room, { type: 'voxelChange', ...modelData }, playerId);
        }
        else if (msg.kind === 'toxsamSpawn' && msg.modelId && msg.assetUrl){
          const modelId = String(msg.modelId).slice(0, 64);
          const data = {
            kind: 'toxsamSpawn', modelId,
            assetUrl: String(msg.assetUrl).slice(0, 500),
            assetName: String(msg.assetName || 'asset').slice(0, 100),
            x: msg.x, y: msg.y, z: msg.z,
            ry: msg.ry || 0,
          };
          pushVoxelChange(room, data);
          broadcastToRoom(player.room, { type: 'voxelChange', ...data }, playerId);
        }
        break;
      }
      case 'ping': sendTo(playerId, { type: 'pong', t: msg.t }); break;
    }
  });

  ws.on('close', () => {
    console.log('[-] ' + playerId + ' disconnected');
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

setInterval(() => {
  const now = Date.now();
  for (const [pid, p] of players){
    if (now - p.lastSeen > 60_000){
      console.log('[clean] Dropping stale ' + pid);
      try { p.ws.close(); } catch(e){}
    }
  }
}, 30_000);

function restartGracefully(reason){
  console.log('[restart] ' + reason);
  saveState();
  for (const [pid, p] of players){
    try {
      p.ws.send(JSON.stringify({ type: 'serverRestart', reason }));
      p.ws.close();
    } catch(e){}
  }
  setTimeout(() => process.exit(0), 1000);
}

setTimeout(() => restartGracefully('Scheduled 90-min restart'), RESTART_INTERVAL_MS);

setInterval(() => {
  const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memMB > RAM_LIMIT_MB){
    restartGracefully('RAM overload: ' + memMB.toFixed(0) + 'MB');
  }
}, 10_000);

let lastLagCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = (now - lastLagCheck) - 1000;
  if (lag > EVENT_LOOP_LAG_LIMIT_MS){
    restartGracefully('Event loop lag: ' + lag + 'ms');
    return;
  }
  lastLagCheck = now;
}, 1000);

process.on('SIGTERM', () => {
  console.log('[sig] SIGTERM');
  saveState();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log('================================');
  console.log('JJK Sandbox Server v5');
  console.log('Mode: SANDBOX (no combat)');
  console.log('Listening on :' + PORT);
  console.log('Health: /health');
  console.log('Rooms:  /rooms');
  console.log('Auto-restart: ' + (RESTART_INTERVAL_MS / 60000) + ' min');
  console.log('================================');
});
