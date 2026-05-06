// ============================================================
// JJK 24FRAMES — Sandbox Multiplayer Server (v12)
// ============================================================
// Pivote: SANDBOX puro (estilo Garry's Mod). Sin combate PvP.
//
// Cambios principales vs v11:
// 1. ✅ AUTO-LIMPIEZA al quedar sala vacía: cuando todos los players salen de
//    una sala (incluso pinned como "flat"), se borran TODOS los GLBs spawneados,
//    voxelChanges, props, ragdolls y dummies. Solo se conserva customMapId.
//    Esto evita los "zombies" de sesiones pasadas que aparecían sin owner.
// 2. ✅ Endpoint HTTP /clear-room/:id para limpiar manualmente una sala sin
//    tener que esperar a que se vacíe. Uso: GET /clear-room/flat
//
// Cambios v11 (heredados):
//   - AUTO-REGISTER props desconocidos en propGrab/Update/Scale/Freeze
//   - SANDBOX MODE sin ownership check (cualquiera puede manipular)
//   - propUpdate sin filtro de owner
//
// Cambios v10 (heredados):
//   - pose como OBJETO con rotaciones reales
//   - roomState manda 'players' + 'others' (dual compat)
//   - emote, dummies, skin, chat handlers
//   - playerName/color en joinRoom
//
// Compatibilidad: 100% backwards con clientes v9/v10/v11.
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
const STATE_VERSION = 4; // bump para invalidar saves de v9

const players = new Map();
const rooms = new Map();
let nextPlayerId = 1;

const PINNED_ROOMS = [
  { id: 'flat',      name: 'Flat',      jp: '',  maxPlayers: 30, customMapId: 'flat' },
  { id: 'blocky',    name: 'Blocky',    jp: '',  maxPlayers: 30, customMapId: 'blocky' },
  { id: 'construct', name: 'Construct', jp: '',  maxPlayers: 30, customMapId: 'construct' },
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
    customMapId: opts.customMapId || null,
    props: new Map(),
    ragdolls: new Map(),
    dummies: new Map(),       // ⭐ v10: dummies sincronizados (NPCs spawned)
    activeMap: null,
  };
}

function initPinnedRooms(){
  for (const p of PINNED_ROOMS){
    if (!rooms.has(p.id)){
      rooms.set(p.id, makeRoom({
        id: p.id, name: p.name, jp: p.jp,
        isPinned: true, maxPlayers: p.maxPlayers,
        customMapId: p.customMapId,
      }));
    } else {
      const existing = rooms.get(p.id);
      if (p.customMapId && !existing.customMapId) existing.customMapId = p.customMapId;
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
        customMapId: room.customMapId,
        voxelChanges: (room.voxelChanges || []).slice(-3000),
        voxelProps: Array.from((room.voxelProps || new Map()).entries()).slice(-1000),
        activeMap: room.activeMap || null,
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
      console.log('[load] Version mismatch (got ' + data.version + ', expected ' + STATE_VERSION + ') - starting fresh');
      return;
    }
    const ageHours = (Date.now() - (data.savedAt || 0)) / 3600000;
    console.log('[load] State age: ' + ageHours.toFixed(1) + 'h');
    for (const r of (data.rooms || [])){
      const room = makeRoom({
        id: r.id, name: r.name, jp: r.jp,
        isPinned: r.isPinned, isPublic: r.isPublic,
        passwordHash: r.passwordHash, maxPlayers: r.maxPlayers,
        customMapId: r.customMapId,
      });
      room.createdAt = r.createdAt || Date.now();
      room.voxelChanges = r.voxelChanges || [];
      room.voxelProps = new Map(r.voxelProps || []);
      room.activeMap = r.activeMap || null;
      rooms.set(r.id, room);
    }
    console.log('[load] Loaded ' + rooms.size + ' rooms');
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
      version: 'v12',
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
        players: r.players.size,
        playersCount: r.players.size,
        maxPlayers: r.maxPlayers,
        voxelChanges: (r.voxelChanges || []).length,
        voxelProps: (r.voxelProps || new Map()).size,
      });
    }
    res.end(JSON.stringify(list));
    return;
  }
  // ⭐ v12: endpoint para limpiar una sala manualmente (forzar reset de GLBs)
  // Uso: GET /clear-room/flat → limpia voxelChanges, voxelProps, props
  // Si hay players, los desconecta para que reentren en estado limpio.
  if (req.url && req.url.startsWith('/clear-room/')){
    const roomId = req.url.substring('/clear-room/'.length).split('?')[0];
    const room = rooms.get(roomId);
    if (!room){
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Room not found: ' + roomId }));
      return;
    }
    const before = {
      voxelChanges: (room.voxelChanges || []).length,
      voxelProps: room.voxelProps.size,
      props: room.props.size,
      players: room.players.size,
    };
    room.voxelChanges = [];
    room.voxelProps.clear();
    room.props.clear();
    room.ragdolls.clear();
    room.dummies.clear();
    stateDirty = true;
    // Avisar a todos los players que la sala se reseteó
    broadcastToRoom(roomId, { type: 'roomCleared', message: 'Sala reseteada por admin' });
    console.log('[v12 manual cleanup] ' + roomId + ': cleared ' + JSON.stringify(before));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, room: roomId, cleared: before }));
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

  // ⭐ Broadcast 'join' a otros con TODOS los datos del player
  broadcastToRoom(roomId, {
    type: 'join',
    id: player.id, name: player.name,
    x: player.x, z: player.z, yaw: player.yaw,
    color: player.color,
    skinId: player.skinId,
    pose: player.pose,
  }, player.id);

  // ⭐ v10: roomState con 'players' (lo que espera el cliente nuevo)
  // Y también 'others' por compat con cliente v9 (no rompe nada).
  const playersList = [];
  for (const pid of room.players){
    if (pid === player.id) continue;
    const o = players.get(pid);
    if (o) playersList.push({
      id: o.id, name: o.name,
      x: o.x, z: o.z, yaw: o.yaw,
      color: o.color,
      skinId: o.skinId,
      pose: o.pose,
    });
  }
  sendTo(player.id, {
    type: 'roomState',
    roomId,
    roomName: room.name,
    players: playersList,    // nombre canónico
    others: playersList,     // alias backwards-compat
    dummies: Array.from((room.dummies || new Map()).values()),
  });

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
  if (room.customMapId){
    sendTo(player.id, { type: 'customMapLoad', mapId: room.customMapId });
  }
  if (room.props && room.props.size > 0){
    const propsArray = [];
    for (const [mpId, p] of room.props){
      propsArray.push({
        mpId, kind: p.kind, params: p.params,
        x: p.x, y: p.y, z: p.z,
        qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw,
        scale: p.scale || 1,
        color: p.color || null,
        frozen: !!p.frozen,
        grabbedBy: p.grabbedBy || null,
      });
    }
    sendTo(player.id, { type: 'propsBatch', props: propsArray });
  }
  if (room.ragdolls && room.ragdolls.size > 0){
    for (const [mpId, r] of room.ragdolls){
      sendTo(player.id, {
        type: 'ragdollActivate',
        mpId, propMpId: r.propMpId,
        sourceId: r.sourceId,
        modelKey: r.modelKey,
        externalAsset: r.externalAsset,
        bonesTags: r.bonesTags,
      });
      if (r.bones && r.bones.length > 0){
        sendTo(player.id, { type: 'ragdollUpdate', ragdolls: [{ id: mpId, bones: r.bones }] });
      }
    }
  }
  if (room.activeMap){
    sendTo(player.id, {
      type: 'mapLoad',
      url: room.activeMap.url,
      name: room.activeMap.name,
      sourceId: room.activeMap.sourceId,
      scale: room.activeMap.scale,
      rotY: room.activeMap.rotY,
      spawnY: room.activeMap.spawnY,
    });
  }
  return true;
}

// ⭐ Helper: sanitizar pose. Acepta string (legacy v9) o objeto (v10 nuevo).
function sanitizePose(pose){
  if (typeof pose === 'string') return pose.slice(0, 20);
  if (pose && typeof pose === 'object'){
    // Solo aceptamos las claves conocidas, todas como números.
    const POSE_KEYS = ['aLx','aRx','aLz','aRz','lLx','lRx','lLz','lRz','bodyY','lean','tilt'];
    const out = {};
    for (const k of POSE_KEYS){
      if (typeof pose[k] === 'number' && isFinite(pose[k])){
        out[k] = Math.max(-3.2, Math.min(3.2, pose[k])); // clamp a rango razonable de radianes
      }
    }
    return out;
  }
  return null;
}

wss.on('connection', (ws) => {
  const playerId = genPlayerId();
  const player = {
    id: playerId, ws,
    name: 'Player' + playerId,
    room: null,
    x: 0, z: 0, yaw: 0,
    pose: null,           // ⭐ ahora puede ser objeto o string
    color: '#4a90c0',
    skinId: 'classic',
    lastSeen: Date.now(),
  };
  players.set(playerId, player);
  console.log('[+] ' + playerId + ' connected (' + players.size + ' total)');

  try { ws.send(JSON.stringify({ type: 'welcome', id: playerId, mode: 'sandbox', serverVersion: 'v10' })); } catch(e){}

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    player.lastSeen = Date.now();

    try {
      switch (msg.type){

        // ============== IDENTITY ==============
        case 'setName': {
          if (typeof msg.name === 'string') player.name = msg.name.slice(0, 20);
          if (typeof msg.color === 'string') player.color = msg.color.slice(0, 32);
          break;
        }

        // ============== ROOMS ==============
        case 'listRooms': {
          const list = [];
          for (const [rid, r] of rooms){
            list.push({
              id: r.id, name: r.name, jp: r.jp,
              isPinned: r.isPinned, isPublic: r.isPublic,
              hasPassword: !!r.passwordHash,
              players: r.players.size,
              playersCount: r.players.size,  // alias
              maxPlayers: r.maxPlayers,
            });
          }
          sendTo(playerId, { type: 'roomList', rooms: list });
          break;
        }
        case 'createRoom': {
          // ⭐ v10: aceptar nombre y color del player en el mismo mensaje (sin necesitar setName previo)
          if (typeof msg.playerName === 'string') player.name = msg.playerName.slice(0, 20);
          if (typeof msg.color === 'string') player.color = msg.color.slice(0, 32);
          else if (typeof msg.color === 'number') player.color = '#' + msg.color.toString(16).padStart(6, '0');

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
          sendTo(playerId, { type: 'roomCreated', roomId: id, name, hasPassword: !!pwHash });
          // ⭐ v10: auto-join al crearse
          joinPlayerToRoom(player, id);
          break;
        }
        case 'joinRoom': {
          // ⭐ v10: aceptar nombre y color del player en el mismo mensaje
          if (typeof msg.playerName === 'string') player.name = msg.playerName.slice(0, 20);
          if (typeof msg.color === 'string') player.color = msg.color.slice(0, 32);
          else if (typeof msg.color === 'number') player.color = '#' + msg.color.toString(16).padStart(6, '0');

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

        // ============== STATE / POSE / ANIM ==============
        case 'state': {
          if (typeof msg.x === 'number') player.x = msg.x;
          if (typeof msg.z === 'number') player.z = msg.z;
          if (typeof msg.yaw === 'number') player.yaw = msg.yaw;
          // ⭐ v10: pose puede ser string (legacy) U OBJETO (rotaciones completas)
          // Esto permite ver las animaciones REALES del otro jugador (caminar, idle, FPS aim, emotes).
          // Aceptamos también 'poseObj' como fallback para clientes que mandan ambos.
          const pose = sanitizePose(msg.poseObj || msg.pose);
          if (pose !== null) player.pose = pose;

          if (player.room){
            broadcastToRoom(player.room, {
              type: 'state', id: playerId,
              x: player.x, z: player.z,
              yaw: player.yaw, pose: player.pose,
            }, playerId);
          }
          break;
        }
        case 'role': break;
        case 'skin': {
          if (typeof msg.skinId === 'string'){
            player.skinId = msg.skinId.slice(0, 20);
          }
          if (player.room){
            broadcastToRoom(player.room, {
              type: 'skin', id: playerId, skinId: player.skinId,
            }, playerId);
          }
          break;
        }

        // ============== CHAT / EMOTE ==============
        case 'chat': {
          if (player.room){
            const text = String(msg.text || '').slice(0, 200);
            broadcastToRoom(player.room, {
              type: 'chat', id: playerId, name: player.name, text,
            });
          }
          break;
        }
        case 'emote': {
          // ⭐ v10 NUEVO: relay de emotes. El cliente recibe { type:'emote', id, emoji, emoteId, duration }
          if (!player.room) break;
          const emoji = (typeof msg.emoji === 'string') ? msg.emoji.slice(0, 16) : '🎭';
          const emoteId = (typeof msg.id === 'string' || typeof msg.emoteId === 'string')
            ? String(msg.id || msg.emoteId).slice(0, 64) : null;
          const duration = (typeof msg.duration === 'number') ? Math.max(0.3, Math.min(15, msg.duration)) : 2.5;
          broadcastToRoom(player.room, {
            type: 'emote',
            id: playerId,
            emoji,
            emoteId,
            duration,
          }, playerId);
          break;
        }

        // ============== DUMMY (NPC) SYNC (v10 NUEVO) ==============
        case 'dummySpawn': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room) break;
          if (!room.dummies) room.dummies = new Map();
          if (room.dummies.size >= 30) break; // limit
          if (!msg.id) break;
          const d = {
            id: String(msg.id).slice(0, 64),
            x: +msg.x || 0,
            y: +msg.y || 0,
            z: +msg.z || 0,
            hp: +msg.hp || 1000,
            maxHp: +msg.maxHp || msg.hp || 1000,
            kind: (typeof msg.kind === 'string') ? msg.kind.slice(0, 30) : 'classic',
            ownerId: playerId,
            spawnedAt: Date.now(),
          };
          room.dummies.set(d.id, d);
          broadcastToRoom(player.room, { type: 'dummySpawn', ...d });
          break
