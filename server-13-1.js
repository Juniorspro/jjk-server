// ============================================================
// JJK 24FRAMES — Sandbox Multiplayer Server (v13) — SERVER-AUTHORITATIVE PHYSICS
// ============================================================
// Pivote: el SERVER simula físicas con Cannon-es. Los clientes solo envían
// inputs (grab/release con velocity) y reciben snapshots de posiciones.
//
// Cambios principales vs v12:
// 1. ✅ Cada room tiene un CANNON.World con gravity (-9.82 Y).
// 2. ✅ propSpawn → crea body en server con shape según kind/params.
// 3. ✅ propGrab → body pasa a KINEMATIC, se mueve siguiendo propUpdate del grabber.
// 4. ✅ propRelease → body pasa a DYNAMIC con velocity aplicada.
// 5. ✅ Tick a 30Hz: world.fixedStep(1/30) por cada room con players activos.
// 6. ✅ Snapshot a 20Hz: broadcast de posiciones autoritativas a todos.
// 7. ✅ Sleep automático para props quietos (ahorra CPU).
// 8. ✅ Sanity check: bodies a posiciones absurdas son reseteados al origen.
//
// Cambios v12 (heredados):
//   - AUTO-LIMPIEZA al quedar sala vacía
//   - Endpoint /clear-room/:id
//
// Compatibilidad: rompe parcialmente con clientes pre-v44-51.
// Los clientes viejos que no manden propClientPredict van a ver el throw
// con ~150ms de delay pero todo lo demás funciona.
// ============================================================

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const CANNON = require('cannon-es');

const PORT = process.env.PORT || 8080;
const STATE_FILE = '/tmp/jjk_world_state.json';
const SAVE_INTERVAL_MS = 30_000;
const RESTART_INTERVAL_MS = 90 * 60 * 1000;
const RAM_LIMIT_MB = 400;
const EVENT_LOOP_LAG_LIMIT_MS = 1500;
const STATE_VERSION = 5; // v13 incluye snapshots de bodies, bump para invalidar saves v12

// ⭐ Constantes de simulación física
const PHYSICS_TICK_RATE = 30;          // Hz — frecuencia de world.step()
const PHYSICS_DT = 1 / PHYSICS_TICK_RATE;
const SNAPSHOT_RATE = 20;              // Hz — frecuencia de broadcast a clientes
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;
const MAX_BODIES_PER_ROOM = 60;        // Límite duro para no quemar CPU en Render free tier
const RUNAWAY_LIMIT = 200;             // Si |x|>200 o |y|>200 o |z|>200 → reset

const players = new Map();
const rooms = new Map();
let nextPlayerId = 1;

const PINNED_ROOMS = [
  { id: 'flat',      name: 'Flat',      jp: '',  maxPlayers: 30, customMapId: 'flat' },
  { id: 'blocky',    name: 'Blocky',    jp: '',  maxPlayers: 30, customMapId: 'blocky' },
  { id: 'construct', name: 'Construct', jp: '',  maxPlayers: 30, customMapId: 'construct' },
];

function makeRoom(opts){
  // ⭐ v13: cada room tiene su propio CANNON.World
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
  });
  world.broadphase = new CANNON.NaiveBroadphase();
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.1;
  // Piso infinito a Y=0 para que los props no caigan al vacío
  const groundShape = new CANNON.Plane();
  const groundBody = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
  groundBody.addShape(groundShape);
  groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  world.addBody(groundBody);
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
    props: new Map(),                      // metadata (kind, params, scale, ownerId, etc)
    bodies: new Map(),                     // ⭐ mpId → CANNON.Body (físicas autoritativas)
    world,                                 // ⭐ CANNON.World propio
    groundBody,                            // ref para no perderlo
    lastSnapshotMs: 0,                     // último envío de snapshot
    lastTickMs: Date.now(),                // último step físico
    ragdolls: new Map(),
    dummies: new Map(),
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

// ============================================================
// ⭐ v13: HELPERS DE FÍSICAS SERVIDOR-AUTORITATIVAS
// ============================================================

// Construye un CANNON.Body apropiado según el kind/params del prop
function buildBodyForProp(kind, params, x, y, z, scale){
  scale = scale || 1;
  let shape, mass = 4;
  const sz = (params && params.size) ? +params.size : 2;
  // Tamaño escalado
  const s = sz * scale;
  switch (kind){
    case 'aiShape': {
      const shapeType = params && params.shapeType;
      switch (shapeType){
        case 'sphere':   shape = new CANNON.Sphere(s/2); mass = 3; break;
        case 'cylinder': shape = new CANNON.Cylinder(s/2, s/2, s, 12); mass = 4; break;
        case 'cone':     shape = new CANNON.Cylinder(0.05, s/2, s, 12); mass = 3; break;
        case 'torus':    shape = new CANNON.Sphere(s * 0.6); mass = 2.5; break;
        case 'plank':    shape = new CANNON.Box(new CANNON.Vec3(s/2, 0.15*scale, s/4)); mass = 2; break;
        case 'ramp':     shape = new CANNON.Box(new CANNON.Vec3(s/2, 0.25*scale, s/2)); mass = 3; break;
        case 'cube':
        default:         shape = new CANNON.Box(new CANNON.Vec3(s/2, s/2, s/2)); mass = 4; break;
      }
      break;
    }
    case 'constructProp':
    case 'externalAsset':
    default: {
      // Genérico: caja del tamaño dado
      shape = new CANNON.Box(new CANNON.Vec3(s/2, s/2, s/2));
      mass = 4;
      break;
    }
  }
  const body = new CANNON.Body({
    mass,
    shape,
    position: new CANNON.Vec3(x, y, z),
    linearDamping: 0.05,
    angularDamping: 0.1,
    allowSleep: true,
    sleepSpeedLimit: 0.1,
    sleepTimeLimit: 1.0,
  });
  body._origMass = mass;
  body._kind = kind;
  return body;
}

// Sanity check: bodies que volaron al espacio se resetean
function sanitizeBody(body){
  const p = body.position;
  if (Math.abs(p.x) > RUNAWAY_LIMIT || Math.abs(p.y) > RUNAWAY_LIMIT || Math.abs(p.z) > RUNAWAY_LIMIT){
    body.position.set(0, 5, 0);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    if (body.previousPosition) body.previousPosition.copy(body.position);
    return true;
  }
  return false;
}

// Limpia el world de una room (al vaciar la sala)
function clearRoomPhysics(room){
  if (!room || !room.world) return;
  for (const [mpId, body] of room.bodies){
    room.world.removeBody(body);
  }
  room.bodies.clear();
}

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
    let totalBodies = 0, activePhysicsRooms = 0;
    for (const [, r] of rooms){
      if (r.bodies && r.players.size > 0){
        activePhysicsRooms++;
        totalBodies += r.bodies.size;
      }
    }
    res.end(JSON.stringify({
      status: 'ok',
      mode: 'sandbox',
      version: 'v13',
      physics: 'server-authoritative',
      tickRate: PHYSICS_TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      players: players.size,
      rooms: rooms.size,
      activePhysicsRooms,
      bodies: totalBodies,
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
    clearRoomPhysics(room); // ⭐ v13: también limpiar bodies físicos
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

        // ============== PROP SYNC (Server-Authoritative Physics) ==============
        case 'propSpawn': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room) break;
          if (!msg.mpId || !msg.kind) break;
          if (room.props.size >= MAX_BODIES_PER_ROOM) break;
          // Metadata
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
          // ⭐ v13: crear body físico autoritativo en el server
          const body = buildBodyForProp(
            msg.kind, msg.params || {},
            +msg.x || 0, +msg.y || 0, +msg.z || 0,
            +msg.scale || 1
          );
          body._mpId = msg.mpId;
          room.world.addBody(body);
          room.bodies.set(msg.mpId, body);
          // Broadcast a todos (incluido sender, para que sepa que el server lo aceptó)
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
          // ⭐ v13: en server-authoritative el cliente ya NO es la fuente de verdad
          // de las posiciones. Sin embargo, mientras un prop está GRABBED, el grabber
          // sí es autoridad (estilo "manipulación directa" en Gmod). Solo aplicamos
          // updates de bodies que están grabbedBy === playerId.
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !Array.isArray(msg.props)) break;
          for (const p of msg.props){
            const stored = room.props.get(p.id);
            if (!stored) continue;
            if (stored.grabbedBy !== playerId) continue; // solo el grabber actualiza
            stored.x = +p.x; stored.y = +p.y; stored.z = +p.z;
            stored.qx = +p.qx; stored.qy = +p.qy; stored.qz = +p.qz; stored.qw = +p.qw;
            // Sincronizar el body físico (que está KINEMATIC mientras grabbed)
            const body = room.bodies.get(p.id);
            if (body){
              body.position.set(+p.x, +p.y, +p.z);
              body.quaternion.set(+p.qx, +p.qy, +p.qz, +p.qw);
              if (body.previousPosition) body.previousPosition.copy(body.position);
              if (body.previousQuaternion) body.previousQuaternion.copy(body.quaternion);
            }
          }
          // No reenviamos propUpdate — el snapshot tick lo hace por nosotros
          break;
        }
        case 'propGrab': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          let stored = room.props.get(msg.mpId);
          if (!stored){
            // Auto-register sin body físico (caso edge)
            stored = {
              kind: 'externalAsset', params: {}, x: 0, y: 0, z: 0,
              qx: 0, qy: 0, qz: 0, qw: 1, scale: 1, color: null, frozen: false,
              grabbedBy: null, ownerId: playerId,
            };
            room.props.set(msg.mpId, stored);
            const body = buildBodyForProp('externalAsset', {}, 0, 5, 0, 1);
            body._mpId = msg.mpId;
            room.world.addBody(body);
            room.bodies.set(msg.mpId, body);
          }
          stored.grabbedBy = playerId;
          // ⭐ v13: pasar el body a KINEMATIC (sigue al grabber sin físicas)
          const body = room.bodies.get(msg.mpId);
          if (body){
            body._dynMass = body.mass; // guardar para restaurar al release
            body.type = CANNON.Body.KINEMATIC;
            body.mass = 0;
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            body.updateMassProperties();
          }
          broadcastToRoom(player.room, {
            type: 'propGrab', mpId: msg.mpId, grabbedBy: playerId,
          }, playerId);
          break;
        }
        case 'propRelease': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          let stored = room.props.get(msg.mpId);
          if (!stored){
            stored = {
              kind: 'externalAsset', params: {},
              x: +msg.x || 0, y: +msg.y || 0, z: +msg.z || 0,
              qx: 0, qy: 0, qz: 0, qw: 1, scale: 1, color: null, frozen: false,
              grabbedBy: null, ownerId: playerId,
            };
            room.props.set(msg.mpId, stored);
            const body = buildBodyForProp('externalAsset', {}, +msg.x||0, +msg.y||5, +msg.z||0, 1);
            body._mpId = msg.mpId;
            room.world.addBody(body);
            room.bodies.set(msg.mpId, body);
          }
          stored.grabbedBy = null;
          if (msg.x !== undefined) stored.x = +msg.x;
          if (msg.y !== undefined) stored.y = +msg.y;
          if (msg.z !== undefined) stored.z = +msg.z;
          if (msg.qx !== undefined) stored.qx = +msg.qx;
          if (msg.qy !== undefined) stored.qy = +msg.qy;
          if (msg.qz !== undefined) stored.qz = +msg.qz;
          if (msg.qw !== undefined) stored.qw = +msg.qw;
          // ⭐ v13: aplicar velocity al body autoritativo. El server simulará
          // la trayectoria y los snapshots harán el broadcast.
          const body = room.bodies.get(msg.mpId);
          if (body){
            // Sanity check de velocity
            const vx = +(msg.vx || 0), vy = +(msg.vy || 0), vz = +(msg.vz || 0);
            const speedSqrd = vx*vx + vy*vy + vz*vz;
            if (speedSqrd > 200*200){
              // Velocity absurda → ignorar
              body.velocity.set(0, 0, 0);
            } else {
              body.velocity.set(vx, vy, vz);
            }
            // Posición y quaternion del momento del release
            if (msg.x !== undefined) body.position.set(+msg.x, +msg.y, +msg.z);
            if (msg.qx !== undefined) body.quaternion.set(+msg.qx, +msg.qy, +msg.qz, +msg.qw);
            if (body.previousPosition) body.previousPosition.copy(body.position);
            if (body.previousQuaternion) body.previousQuaternion.copy(body.quaternion);
            // Angular velocity
            const avx = +(msg.avx || 0), avy = +(msg.avy || 0), avz = +(msg.avz || 0);
            if (avx*avx + avy*avy + avz*avz < 200*200){
              body.angularVelocity.set(avx, avy, avz);
            } else {
              body.angularVelocity.set(0, 0, 0);
            }
            // Volver a DYNAMIC con masa correcta
            body.type = CANNON.Body.DYNAMIC;
            body.mass = body._dynMass || body._origMass || 4;
            body.updateMassProperties();
            body.wakeUp();
          }
          // Broadcast inicial del release a todos (no al sender — él ya predijo localmente)
          broadcastToRoom(player.room, {
            type: 'propRelease', mpId: msg.mpId,
            x: msg.x, y: msg.y, z: msg.z,
            qx: msg.qx, qy: msg.qy, qz: msg.qz, qw: msg.qw,
            vx: msg.vx || 0, vy: msg.vy || 0, vz: msg.vz || 0,
            avx: msg.avx || 0, avy: msg.avy || 0, avz: msg.avz || 0,
          }, playerId);
          break;
        }
        case 'propScale': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          // ⭐ v11: auto-register si no existe
          let stored = room.props.get(msg.mpId);
          if (!stored){
            stored = {
              kind: 'externalAsset',
              params: {},
              x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
              scale: 1, color: null, frozen: false,
              grabbedBy: null, ownerId: playerId,
            };
            room.props.set(msg.mpId, stored);
          }
          // ⭐ v11: SANDBOX — sin ownership check, cualquiera puede escalar
          stored.scale = Math.max(0.1, Math.min(10, +msg.scale || 1));
          // v12: no echo al sender
          broadcastToRoom(player.room, { type: 'propScale', mpId: msg.mpId, scale: stored.scale }, playerId);
          break;
        }
        case 'propFreeze': {
          if (!player.room) break;
          const room = rooms.get(player.room);
          if (!room || !msg.mpId) break;
          let stored = room.props.get(msg.mpId);
          if (!stored){
            stored = {
              kind: 'externalAsset',
              params: {},
              x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
              scale: 1, color: null, frozen: false,
              grabbedBy: null, ownerId: playerId,
            };
            room.props.set(msg.mpId, stored);
          }
          // ⭐ v11: SANDBOX — cualquiera puede freeze/unfreeze
          stored.frozen = !!msg.frozen;
          if (stored.frozen) stored.grabbedBy = null;
          // v12: no echo al sender
          broadcastToRoom(player.room, {
            type: 'propFreeze', mpId: msg.mpId, frozen: stored.frozen,
            x: stored.x, y: stored.y, z: stored.z,
            qx: stored.qx, qy: stored.qy, qz: stored.qz, qw: stored.qw,
          }, playerId);
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
        // ⭐ v12: si la sala quedó VACÍA, limpiar TODOS los GLBs spawneados
        // (toxsamSpawn/modelSpawn/props) para que la próxima sesión arranque limpia.
        // Salas pinned conservan su customMapId pero no los props del usuario.
        if (room.players.size === 0){
          console.log('[v13 cleanup] Room ' + room.id + ' is empty, clearing user-spawned content');
          room.voxelChanges = [];
          room.voxelProps.clear();
          room.props.clear();
          clearRoomPhysics(room); // ⭐ v13: limpiar bodies físicos
          room.ragdolls.clear();
          room.dummies.clear();
          stateDirty = true;
        }
      }
    }
    players.delete(playerId);
  });

  ws.on('error', () => { try { ws.close(); } catch(e){} });
});

// ============================================================
// ⭐ v13: PHYSICS TICK + SNAPSHOT BROADCAST
// ============================================================
// Cada 33ms (30Hz) corremos world.fixedStep() en cada room con players.
// Cada 50ms (20Hz) mandamos snapshot de posiciones a todos.
// Si la room está vacía, no simulamos (ahorra CPU).
// ============================================================
let _physicsTickCount = 0;
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms){
    if (!room.world) continue;
    if (room.players.size === 0) continue; // skip rooms vacías

    // 1. Step físico (1/30 seg de simulación)
    try {
      room.world.fixedStep(PHYSICS_DT);
    } catch (e){
      console.warn('[physics] step error:', roomId, e.message);
      continue;
    }

    // 2. Sanity check + sync metadata desde body físico
    for (const [mpId, body] of room.bodies){
      // Sanity (bodies fugados)
      if (sanitizeBody(body)){
        console.warn('[physics] runaway reset:', mpId);
      }
      // Actualizar metadata stored para persistencia/save
      const stored = room.props.get(mpId);
      if (stored && stored.grabbedBy === null){
        stored.x = body.position.x;
        stored.y = body.position.y;
        stored.z = body.position.z;
        stored.qx = body.quaternion.x;
        stored.qy = body.quaternion.y;
        stored.qz = body.quaternion.z;
        stored.qw = body.quaternion.w;
      }
    }

    // 3. Broadcast snapshot a 20Hz (cada 50ms)
    if (now - room.lastSnapshotMs >= SNAPSHOT_INTERVAL_MS){
      room.lastSnapshotMs = now;
      const props = [];
      for (const [mpId, body] of room.bodies){
        // Skip props GRABBED (el grabber es la autoridad, manda propUpdate)
        const stored = room.props.get(mpId);
        if (stored && stored.grabbedBy !== null) continue;
        // Skip bodies dormidos que no se movieron desde último snapshot
        // (clientes ya tienen la última pos, no necesitan duplicarla)
        if (body.sleepState === CANNON.Body.SLEEPING && body._wasSleepingLastSnap){
          continue;
        }
        body._wasSleepingLastSnap = (body.sleepState === CANNON.Body.SLEEPING);
        props.push({
          id: mpId,
          x: Math.round(body.position.x * 100) / 100,
          y: Math.round(body.position.y * 100) / 100,
          z: Math.round(body.position.z * 100) / 100,
          qx: Math.round(body.quaternion.x * 1000) / 1000,
          qy: Math.round(body.quaternion.y * 1000) / 1000,
          qz: Math.round(body.quaternion.z * 1000) / 1000,
          qw: Math.round(body.quaternion.w * 1000) / 1000,
          // velocidad para extrapolación en cliente (cuando no llega el siguiente snapshot)
          vx: Math.round(body.velocity.x * 100) / 100,
          vy: Math.round(body.velocity.y * 100) / 100,
          vz: Math.round(body.velocity.z * 100) / 100,
        });
      }
      if (props.length > 0){
        const snapshot = JSON.stringify({ type: 'propSnapshot', t: now, props });
        for (const pid of room.players){
          const player = players.get(pid);
          if (player && player.ws && player.ws.readyState === 1){
            try { player.ws.send(snapshot); } catch(e){}
          }
        }
      }
    }
  }
  _physicsTickCount++;
  if (_physicsTickCount % 300 === 0){
    // log cada ~10 segundos
    let totalBodies = 0, activeRooms = 0;
    for (const [, r] of rooms){
      if (r.players.size > 0){
        activeRooms++;
        totalBodies += r.bodies ? r.bodies.size : 0;
      }
    }
    console.log('[physics] tick #' + _physicsTickCount + ' | active rooms: ' + activeRooms + ' | bodies: ' + totalBodies);
  }
}, Math.round(1000 / PHYSICS_TICK_RATE)); // ~33ms = 30Hz

// Cleanup de players inactivos (heredado de v12)
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
  console.log('JJK Sandbox Server v13 — SERVER-AUTHORITATIVE PHYSICS');
  console.log('Mode: SANDBOX (Garry\'s Mod style)');
  console.log('Listening on :' + PORT);
  console.log('Health: /health');
  console.log('Rooms:  /rooms');
  console.log('Auto-restart: ' + (RESTART_INTERVAL_MS / 60000) + ' min');
  console.log('NEW IN v13:');
  console.log('  - Cannon.js running on server (each room has its own World)');
  console.log('  - Physics tick: ' + PHYSICS_TICK_RATE + 'Hz, snapshot rate: ' + SNAPSHOT_RATE + 'Hz');
  console.log('  - propSnapshot message: server broadcasts authoritative positions');
  console.log('  - Sanity check on runaway bodies (limit ' + RUNAWAY_LIMIT + ')');
  console.log('  - Max ' + MAX_BODIES_PER_ROOM + ' bodies per room');
  console.log('================================');
});
