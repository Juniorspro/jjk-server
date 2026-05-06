// ============================================================
// JJK 24FRAMES — Sandbox Multiplayer Server (v10)
// ============================================================
// Pivote: SANDBOX puro (estilo Garry's Mod). Sin combate PvP.
//
// Cambios principales vs v9:
// 1. ✅ pose como OBJETO (con todas las rotaciones de brazos/piernas).
//    Antes solo aceptaba pose como string corto, ahora acepta los 11 floats.
//    Permite ver la animación EXACTA del otro player (caminar, idle, FPS aim, emotes).
// 2. ✅ roomState manda 'players' (no 'others') para alinearse con el cliente.
//    También mandamos 'others' por si hay clientes viejos (compat dual).
// 3. ✅ Handler 'emote': los emotes se sincronizan entre todos los players de la sala.
// 4. ✅ Handler 'dummySpawn'/'dummyDamage'/'dummyDie': sync de muñecos NPC interactuables.
// 5. ✅ playerName/color en joinRoom directamente (sin requerir setName previo).
// 6. ✅ skinId persiste en player y se incluye en spawn/roomState.
// 7. ✅ Heartbeat (ping/pong) con timestamp.
// 8. ✅ Stats expandidos en /health.
// 9. ✅ Más tolerante con mensajes malformados (no crashea).
// 10. ❌ Removido: playerDamage, playerDie, playerRespawn, attack, remate (eran del modo PvP).
//
// Lo que SÍ es relevante para sandbox y está sincronizado:
//   - Posición + animación de cada player (pose objeto)
//   - Emotes (poses pre-hechas)
//   - Skins (apariencia)
//   - Props físicos (Cannon): spawn, update, grab, release, scale, freeze, remove
//   - Voxels: remove, modelSpawn, toxsamSpawn (GLBs externos)
//   - Mapas: mapLoad (GLB) + customMapLoad (mapas built-in)
//   - Ragdolls: activate + bones update
//   - Dummies: NPCs que el dueño puede manipular
//   - Chat
//
// Compatibilidad: server v10 acepta clientes v9 sin romper nada.
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
      version: 'v10',
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
        // ⭐ v10: mandamos AMBOS nombres por compatibilidad con cualquier cliente
        players: r.players.size,        // numérico para compat con cliente nuevo
        playersCount: r.players.size,   // por compat con cliente v6
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
          break;
        }
        case 'dummyDamage': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !room.dummies) break;
          const d = room.dummies.get(String(msg.id || ''));
          if (!d) break;
          const amount = +msg.amount || 0;
          d.hp = Math.max(0, d.hp - amount);
          broadcastToRoom(player.room, {
            type: 'dummyDamage',
            id: d.id,
            amount,
            hp: d.hp,
            hitTarget: msg.hitTarget,
            hitDirX: msg.hitDirX,
            hitDirZ: msg.hitDirZ,
            fromId: playerId,
          });
          break;
        }
        case 'dummyDie': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !room.dummies) break;
          const id = String(msg.id || '');
          const d = room.dummies.get(id);
          if (!d) break;
          room.dummies.delete(id);
          broadcastToRoom(player.room, {
            type: 'dummyDie',
            id,
            launchVx: msg.launchVx, launchVy: msg.launchVy, launchVz: msg.launchVz,
          });
          break;
        }

        // ============== VOXEL SYNC (igual que v9) ==============
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

        // ============== MAP SYNC ==============
        case 'mapLoad': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room) break;
          if (msg.url){
            room.activeMap = {
              url: String(msg.url).slice(0, 500),
              name: String(msg.name || 'Map').slice(0, 100),
              sourceId: msg.sourceId ? String(msg.sourceId).slice(0, 30) : null,
              scale: typeof msg.scale === 'number' ? msg.scale : null,
              rotY: typeof msg.rotY === 'number' ? msg.rotY : null,
              spawnY: typeof msg.spawnY === 'number' ? msg.spawnY : null,
            };
          } else {
            room.activeMap = null;
          }
          stateDirty = true;
          broadcastToRoom(player.room, {
            type: 'mapLoad',
            url: msg.url || null,
            name: msg.name || null,
            sourceId: msg.sourceId || null,
            scale: msg.scale,
            rotY: msg.rotY,
            spawnY: msg.spawnY,
          }, playerId);
          break;
        }
        case 'customMapLoad': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room) break;
          if (msg.mapId && typeof msg.mapId === 'string'){
            room.customMapId = msg.mapId.slice(0, 30);
            stateDirty = true;
            broadcastToRoom(player.room, { type: 'customMapLoad', mapId: room.customMapId }, playerId);
          }
          break;
        }

        // ============== PROP SYNC (Cannon physics objects) ==============
        case 'propSpawn': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room) break;
          if (!msg.mpId || !msg.kind) break;
          if (room.props.size >= 200) break;
          room.props.set(msg.mpId, {
            kind: String(msg.kind).slice(0, 30),
            params: msg.params || {},
            x: +msg.x || 0, y: +msg.y || 0, z: +msg.z || 0,
            qx: 0, qy: 0, qz: 0, qw: 1,
            scale: +msg.scale || 1,
            color: msg.color || null,
            frozen: false,
            grabbedBy: null,
            ownerId: playerId,
          });
          broadcastToRoom(player.room, {
            type: 'propSpawn',
            mpId: msg.mpId, kind: msg.kind,
            params: msg.params || {},
            x: msg.x, y: msg.y, z: msg.z,
            scale: +msg.scale || 1,
            color: msg.color || null,
          }, playerId);
          break;
        }
        case 'propUpdate': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !Array.isArray(msg.props)) break;
          for (const p of msg.props){
            const stored = room.props.get(p.id);
            if (stored && (stored.ownerId === playerId || stored.grabbedBy === playerId)){
              stored.x = +p.x; stored.y = +p.y; stored.z = +p.z;
              stored.qx = +p.qx; stored.qy = +p.qy; stored.qz = +p.qz; stored.qw = +p.qw;
            }
          }
          broadcastToRoom(player.room, { type: 'propUpdate', props: msg.props }, playerId);
          break;
        }
        case 'propGrab': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          const stored = room.props.get(msg.mpId);
          if (!stored) break;
          if (stored.grabbedBy && stored.grabbedBy !== playerId) break;
          stored.grabbedBy = playerId;
          broadcastToRoom(player.room, {
            type: 'propGrab', mpId: msg.mpId, grabbedBy: playerId,
          });
          break;
        }
        case 'propRelease': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          const stored = room.props.get(msg.mpId);
          if (!stored) break;
          if (stored.grabbedBy === playerId){
            stored.grabbedBy = null;
            if (msg.x !== undefined) stored.x = +msg.x;
            if (msg.y !== undefined) stored.y = +msg.y;
            if (msg.z !== undefined) stored.z = +msg.z;
            broadcastToRoom(player.room, {
              type: 'propRelease', mpId: msg.mpId,
              x: msg.x, y: msg.y, z: msg.z,
              vx: msg.vx || 0, vy: msg.vy || 0, vz: msg.vz || 0,
            });
          }
          break;
        }
        case 'propScale': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          const stored = room.props.get(msg.mpId);
          if (!stored) break;
          if (stored.ownerId !== playerId && stored.grabbedBy !== playerId) break;
          stored.scale = Math.max(0.1, Math.min(10, +msg.scale || 1));
          broadcastToRoom(player.room, { type: 'propScale', mpId: msg.mpId, scale: stored.scale });
          break;
        }
        case 'propFreeze': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          const stored = room.props.get(msg.mpId);
          if (!stored) break;
          if (stored.ownerId !== playerId && stored.grabbedBy !== playerId) break;
          stored.frozen = !!msg.frozen;
          if (stored.frozen) stored.grabbedBy = null;
          broadcastToRoom(player.room, {
            type: 'propFreeze', mpId: msg.mpId, frozen: stored.frozen,
            x: stored.x, y: stored.y, z: stored.z,
            qx: stored.qx, qy: stored.qy, qz: stored.qz, qw: stored.qw,
          });
          break;
        }
        case 'propRemove': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          const stored = room.props.get(msg.mpId);
          if (stored && stored.ownerId === playerId){
            room.props.delete(msg.mpId);
            broadcastToRoom(player.room, { type: 'propRemove', mpId: msg.mpId }, playerId);
          }
          break;
        }

        // ============== RAGDOLL SYNC ==============
        case 'ragdollActivate': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          if (room.ragdolls.size >= 50) break;
          room.ragdolls.set(msg.mpId, {
            mpId: msg.mpId,
            propMpId: msg.propMpId || null,
            sourceId: msg.sourceId ? String(msg.sourceId).slice(0, 30) : null,
            modelKey: msg.modelKey ? String(msg.modelKey).slice(0, 100) : null,
            externalAsset: msg.externalAsset || null,
            bonesTags: Array.isArray(msg.bonesTags) ? msg.bonesTags.slice(0, 12) : [],
            bones: [],
            ownerId: playerId,
          });
          broadcastToRoom(player.room, {
            type: 'ragdollActivate',
            mpId: msg.mpId,
            propMpId: msg.propMpId,
            sourceId: msg.sourceId,
            modelKey: msg.modelKey,
            externalAsset: msg.externalAsset,
            bonesTags: msg.bonesTags,
          }, playerId);
          break;
        }
        case 'ragdollUpdate': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !Array.isArray(msg.ragdolls)) break;
          for (const r of msg.ragdolls){
            const stored = room.ragdolls.get(r.id);
            if (stored && stored.ownerId === playerId && Array.isArray(r.bones)){
              stored.bones = r.bones;
            }
          }
          broadcastToRoom(player.room, { type: 'ragdollUpdate', ragdolls: msg.ragdolls }, playerId);
          break;
        }

        // ============== HEARTBEAT ==============
        case 'ping': sendTo(playerId, { type: 'pong', t: msg.t, st: Date.now() }); break;

        default:
          // Mensaje desconocido — ignorar silenciosamente
          break;
      }
    } catch(e){
      console.warn('[err] Handler error for type=' + msg.type + ': ' + e.message);
    }
  });

  ws.on('close', () => {
    console.log('[-] ' + playerId + ' disconnected');
    if (player.room){
      const room = rooms.get(player.room);
      if (room){
        room.players.delete(playerId);
        broadcastToRoom(player.room, { type: 'leave', id: playerId });
        if (room.props){
          for (const [mpId, p] of room.props){
            if (p.grabbedBy === playerId){
              p.grabbedBy = null;
              broadcastToRoom(player.room, {
                type: 'propRelease', mpId,
                x: p.x, y: p.y, z: p.z, vx:0, vy:0, vz:0,
              });
            }
          }
        }
        if (room.ragdolls){
          for (const [mpId, r] of room.ragdolls){
            if (r.ownerId === playerId){
              room.ragdolls.delete(mpId);
            }
          }
        }
        // ⭐ v10: limpiar dummies del jugador desconectado
        if (room.dummies){
          for (const [id, d] of room.dummies){
            if (d.ownerId === playerId){
              room.dummies.delete(id);
              broadcastToRoom(player.room, { type: 'dummyDie', id });
            }
          }
        }
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
  console.log('JJK Sandbox Server v10');
  console.log('Mode: SANDBOX (Garry\'s Mod style)');
  console.log('Listening on :' + PORT);
  console.log('Health: /health');
  console.log('Rooms:  /rooms');
  console.log('Auto-restart: ' + (RESTART_INTERVAL_MS / 60000) + ' min');
  console.log('NEW IN v10:');
  console.log('  - pose as object (real animations sync)');
  console.log('  - emote, dummy handlers');
  console.log('  - roomState compat: players + others');
  console.log('  - playerName/color in joinRoom (no setName needed)');
  console.log('  - skinId persistence');
  console.log('REMOVED (PvP leftovers): attack, remate, playerDamage, playerDie, playerRespawn, propHit');
  console.log('================================');
});
