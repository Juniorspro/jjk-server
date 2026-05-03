// ============================================================
// JJK 24FRAMES — Multiplayer WebSocket Server (v3)
// ============================================================

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const players = new Map();
const rooms = new Map();

let nextPlayerId = 1;
const PLAYER_MAX_HP = 5000;

const PINNED_ROOMS = [
  { id: 'global',   name: 'GLOBAL ARENA',     jp: '対戦', maxPlayers: 30 },
  { id: 'duel',     name: 'DUEL ARENA',       jp: '決闘', maxPlayers: 30 },
  { id: 'training', name: 'TRAINING GROUND',  jp: '練習', maxPlayers: 30 },
];

function initPinnedRooms(){
  for (const p of PINNED_ROOMS){
    rooms.set(p.id, {
      id: p.id,
      name: p.name,
      jp: p.jp,
      isPinned: true,
      isPublic: true,
      passwordHash: null,
      players: new Set(),
      dummies: new Map(),
      nextDummyId: 1,
      maxPlayers: p.maxPlayers,
      createdAt: Date.now(),
    });
  }
}
initPinnedRooms();

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
  if (!pw) return null;
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function broadcastToRoom(roomId, message, excludeId = null){
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const pid of room.players){
    if (pid === excludeId) continue;
    const p = players.get(pid);
    if (p && p.ws.readyState === WebSocket.OPEN){
      try { p.ws.send(payload); } catch(e){}
    }
  }
}

function sendTo(playerId, message){
  const p = players.get(playerId);
  if (p && p.ws.readyState === WebSocket.OPEN){
    try { p.ws.send(JSON.stringify(message)); } catch(e){}
  }
}

function getPublicRoomList(){
  const list = [];
  for (const r of rooms.values()){
    if (r.isPinned){
      list.push({
        id: r.id, name: r.name, jp: r.jp || null,
        isPinned: true, isPublic: true, hasPassword: false,
        players: r.players.size, maxPlayers: r.maxPlayers,
      });
    }
  }
  for (const r of rooms.values()){
    if (!r.isPinned && r.isPublic){
      list.push({
        id: r.id, name: r.name, jp: null,
        isPinned: false, isPublic: true, hasPassword: !!r.passwordHash,
        players: r.players.size, maxPlayers: r.maxPlayers,
      });
    }
  }
  return list;
}

function leaveCurrentRoom(player){
  if (!player.room) return;
  const oldRoom = rooms.get(player.room);
  if (!oldRoom) { player.room = null; return; }
  oldRoom.players.delete(player.id);
  broadcastToRoom(player.room, { type: 'leave', id: player.id });
  if (oldRoom.players.size === 0 && !oldRoom.isPinned){
    rooms.delete(player.room);
  }
  player.room = null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/'){
    let totalDummies = 0;
    for (const r of rooms.values()) totalDummies += r.dummies.size;
    res.writeHead(200, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({
      status: 'ok',
      players: players.size,
      rooms: rooms.size,
      dummies: totalDummies,
    }));
  } else if (req.url === '/rooms'){
    res.writeHead(200, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ rooms: getPublicRoomList() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const playerId = genPlayerId();
  const player = {
    ws,
    id: playerId,
    name: 'Player' + playerId,
    room: null,
    x: 0, z: 0, yaw: 0,
    pose: null,
    color: null,
    hp: PLAYER_MAX_HP,
    maxHP: PLAYER_MAX_HP,
    lastSeen: Date.now(),
  };
  players.set(playerId, player);

  console.log(`[+] ${playerId} connected. Total: ${players.size}`);

  ws.send(JSON.stringify({ type: 'welcome', id: playerId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }
    player.lastSeen = Date.now();

    switch (msg.type){

      case 'listRooms': {
        sendTo(playerId, {
          type: 'roomList',
          rooms: getPublicRoomList(),
        });
        break;
      }

      case 'createRoom': {
        const name = (msg.name || 'Untitled Room').slice(0, 32);
        const isPublic = !!msg.isPublic;
        const password = msg.password ? String(msg.password).slice(0, 32) : null;
        const roomId = genRoomCode();
        const room = {
          id: roomId,
          name,
          jp: null,
          isPinned: false,
          isPublic,
          passwordHash: password ? hashPassword(password) : null,
          players: new Set(),
          dummies: new Map(),
          nextDummyId: 1,
          maxPlayers: 20,
          createdAt: Date.now(),
        };
        rooms.set(roomId, room);
        leaveCurrentRoom(player);
        player.room = roomId;
        player.name = (msg.playerName || player.name).slice(0, 24);
        player.color = msg.color || 0x4a90c0;
        player.hp = PLAYER_MAX_HP;
        room.players.add(playerId);

        sendTo(playerId, {
          type: 'roomCreated',
          roomId,
          name,
          isPublic,
          hasPassword: !!password,
          maxPlayers: room.maxPlayers,
        });
        sendTo(playerId, {
          type: 'roomState',
          roomId,
          roomName: name,
          players: [],
          dummies: [],
        });

        console.log(`[room+] ${playerId} created "${name}" (${roomId}) ${isPublic ? 'public' : 'private'}${password ? ' (pw)' : ''}`);
        break;
      }

      case 'joinRoom': {
        const roomId = String(msg.roomId || '').slice(0, 32).toUpperCase();
        const room = rooms.get(roomId) || rooms.get(roomId.toLowerCase());
        if (!room){
          sendTo(playerId, { type: 'joinError', reason: 'Room not found' });
          break;
        }
        if (room.players.size >= room.maxPlayers){
          sendTo(playerId, { type: 'joinError', reason: 'Room is full (' + room.maxPlayers + ' players max)' });
          break;
        }
        if (room.passwordHash){
          const given = msg.password ? String(msg.password) : '';
          if (hashPassword(given) !== room.passwordHash){
            sendTo(playerId, { type: 'joinError', reason: 'Wrong password' });
            break;
          }
        }
        leaveCurrentRoom(player);
        player.room = room.id;
        player.name = (msg.playerName || player.name).slice(0, 24);
        player.color = msg.color || 0x4a90c0;
        player.hp = PLAYER_MAX_HP;
        room.players.add(playerId);

        const existingPlayers = [];
        for (const pid of room.players){
          if (pid === playerId) continue;
          const p = players.get(pid);
          if (p){
            existingPlayers.push({
              id: p.id, name: p.name, color: p.color,
              x: p.x, z: p.z, yaw: p.yaw, pose: p.pose,
              hp: p.hp, maxHP: p.maxHP,
            });
          }
        }
        const existingDummies = [];
        for (const d of room.dummies.values()){
          existingDummies.push({
            id: d.id, x: d.x, z: d.z,
            hp: d.hp, maxHP: d.maxHP, dying: d.dying || false,
          });
        }
        sendTo(playerId, {
          type: 'roomState',
          roomId: room.id,
          roomName: room.name,
          players: existingPlayers,
          dummies: existingDummies,
        });
        broadcastToRoom(room.id, {
          type: 'join',
          id: playerId,
          name: player.name, color: player.color,
          x: player.x, z: player.z, yaw: player.yaw,
          hp: player.hp, maxHP: player.maxHP,
        }, playerId);

        console.log(`[room→] ${playerId} joined "${room.name}" (${room.players.size}/${room.maxPlayers})`);
        break;
      }

      case 'join': {
        const roomId = (msg.room || 'global').slice(0, 32);
        let room = rooms.get(roomId);
        if (!room){
          room = {
            id: roomId, name: roomId, jp: null,
            isPinned: false, isPublic: true, passwordHash: null,
            players: new Set(), dummies: new Map(), nextDummyId: 1,
            maxPlayers: 20, createdAt: Date.now(),
          };
          rooms.set(roomId, room);
        }
        if (room.players.size >= room.maxPlayers){
          sendTo(playerId, { type: 'joinError', reason: 'Room is full' });
          break;
        }
        leaveCurrentRoom(player);
        player.room = room.id;
        player.name = (msg.name || player.name).slice(0, 24);
        player.color = msg.color || 0x4a90c0;
        player.hp = PLAYER_MAX_HP;
        room.players.add(playerId);

        const existingPlayers = [];
        for (const pid of room.players){
          if (pid === playerId) continue;
          const p = players.get(pid);
          if (p) existingPlayers.push({
            id: p.id, name: p.name, color: p.color,
            x: p.x, z: p.z, yaw: p.yaw, pose: p.pose,
            hp: p.hp, maxHP: p.maxHP,
          });
        }
        const existingDummies = [];
        for (const d of room.dummies.values()){
          existingDummies.push({
            id: d.id, x: d.x, z: d.z,
            hp: d.hp, maxHP: d.maxHP, dying: d.dying || false,
          });
        }
        sendTo(playerId, { type: 'roomState', roomId: room.id, roomName: room.name, players: existingPlayers, dummies: existingDummies });
        broadcastToRoom(room.id, {
          type: 'join', id: playerId,
          name: player.name, color: player.color,
          x: player.x, z: player.z, yaw: player.yaw,
          hp: player.hp, maxHP: player.maxHP,
        }, playerId);
        break;
      }

      case 'leaveRoom': {
        leaveCurrentRoom(player);
        sendTo(playerId, { type: 'leftRoom' });
        break;
      }

      case 'state': {
        if (!player.room) break;
        player.x = msg.x; player.z = msg.z; player.yaw = msg.yaw; player.pose = msg.pose;
        broadcastToRoom(player.room, {
          type: 'state', id: playerId,
          x: msg.x, z: msg.z, yaw: msg.yaw, pose: msg.pose,
        }, playerId);
        break;
      }

      case 'attack': {
        if (!player.room) break;
        broadcastToRoom(player.room, {
          type: 'attack', id: playerId,
          kind: msg.kind, targetId: msg.targetId || null,
          punchType: msg.punchType || null,
          x: msg.x, z: msg.z,
        }, playerId);
        break;
      }

      case 'spawnDummy': {
        if (!player.room) break;
        const room = rooms.get(player.room);
        if (!room) break;
        if (room.dummies.size >= 30){
          sendTo(playerId, { type: 'error', message: 'Too many dummies in this room' });
          break;
        }
        const did = 'd' + (room.nextDummyId++);
        const maxHP = msg.maxHP || (5000 + Math.floor(Math.random() * 5000));
        const dummy = { id: did, x: msg.x || 0, z: msg.z || 0, hp: maxHP, maxHP, dying: false };
        room.dummies.set(did, dummy);
        broadcastToRoom(player.room, {
          type: 'dummySpawn', id: did,
          x: dummy.x, z: dummy.z,
          hp: dummy.hp, maxHP: dummy.maxHP,
        });
        break;
      }

      case 'damageDummy': {
        if (!player.room) break;
        const room = rooms.get(player.room);
        if (!room) break;
        const dummy = room.dummies.get(msg.targetId);
        if (!dummy || dummy.dying) break;
        const amount = Math.max(0, Math.min(50000, msg.amount || 0));
        dummy.hp = Math.max(0, dummy.hp - amount);
        broadcastToRoom(player.room, {
          type: 'dummyDamage', id: dummy.id, fromId: playerId,
          amount, hp: dummy.hp,
          hitTarget: msg.hitTarget || null,
          hitDirX: msg.hitDirX || 0, hitDirZ: msg.hitDirZ || 0,
        });
        if (dummy.hp <= 0 && !dummy.dying){
          dummy.dying = true;
          broadcastToRoom(player.room, {
            type: 'dummyDie', id: dummy.id, byId: playerId,
            launchVx: msg.launchVx || 0, launchVy: msg.launchVy || 0, launchVz: msg.launchVz || 0,
          });
          setTimeout(() => {
            const r = rooms.get(player.room);
            if (r) r.dummies.delete(dummy.id);
          }, 5000);
        }
        break;
      }

      case 'damagePlayer': {
        if (!player.room) break;
        const target = players.get(msg.targetId);
        if (!target || target.room !== player.room) break;
        const amount = Math.max(0, Math.min(2000, msg.amount || 0));
        target.hp = Math.max(0, target.hp - amount);
        broadcastToRoom(player.room, {
          type: 'playerDamage', id: target.id, fromId: playerId,
          amount, hp: target.hp,
          hitTarget: msg.hitTarget || null,
          hitDirX: msg.hitDirX || 0, hitDirZ: msg.hitDirZ || 0,
        });
        if (target.hp <= 0){
          target.hp = 0;
          broadcastToRoom(player.room, { type: 'playerDie', id: target.id, byId: playerId });
          setTimeout(() => {
            target.hp = target.maxHP;
            target.x = 0; target.z = 0;
            broadcastToRoom(player.room, {
              type: 'playerRespawn', id: target.id,
              hp: target.hp, maxHP: target.maxHP,
              x: 0, z: 0,
            });
          }, 3000);
        }
        break;
      }

      case 'remate': {
        if (!player.room) break;
        broadcastToRoom(player.room, {
          type: 'remate', id: playerId,
          targetId: msg.targetId,
          x: msg.x, z: msg.z, yaw: msg.yaw,
        }, playerId);
        break;
      }

      case 'chat': {
        if (!player.room) break;
        const text = (msg.text || '').slice(0, 200);
        broadcastToRoom(player.room, { type: 'chat', id: playerId, name: player.name, text });
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
    leaveCurrentRoom(player);
    players.delete(playerId);
  });

  ws.on('error', () => {
    try { ws.close(); } catch(e){}
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [pid, p] of players){
    if (now - p.lastSeen > 60_000){
      console.log(`[clean] Dropping stale ${pid}`);
      try { p.ws.close(); } catch(e){}
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`JJK Multiplayer Server v3 listening on :${PORT}`);
  console.log(`Pinned rooms: ${PINNED_ROOMS.map(r => r.id).join(', ')}`);
});    const p = players.get(pid);
    if (p && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(payload); } catch (e) {}
    }
  }
}

function sendTo(playerId, message) {
  const p = players.get(playerId);
  if (p && p.ws.readyState === WebSocket.OPEN) {
    try { p.ws.send(JSON.stringify(message)); } catch (e) {}
  }
}

// ============================================================
// HTTP server (for health checks + WebSocket upgrade)
// ============================================================
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      status: 'ok',
      players: players.size,
      rooms: rooms.size,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

// ============================================================
// Connection handler
// ============================================================
wss.on('connection', (ws, req) => {
  const playerId = genPlayerId();
  const player = {
    ws,
    id: playerId,
    name: 'Player' + playerId,
    room: null,
    x: 0, z: 0, yaw: 0,
    pose: null,
    color: null,
    lastSeen: Date.now(),
  };
  players.set(playerId, player);

  console.log(`[+] ${playerId} connected. Total: ${players.size}`);

  // Send welcome
  ws.send(JSON.stringify({
    type: 'welcome',
    id: playerId,
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    player.lastSeen = Date.now();

    switch (msg.type) {

      case 'join': {
        // { type:'join', room: 'roomId', name: 'string', color: 0xrrggbb }
        const roomId = (msg.room || 'main').slice(0, 32);
        if (player.room) {
          // Leave old room
          const oldRoom = rooms.get(player.room);
          if (oldRoom) {
            oldRoom.delete(playerId);
            broadcastToRoom(player.room, { type: 'leave', id: playerId });
            if (oldRoom.size === 0) rooms.delete(player.room);
          }
        }
        player.room = roomId;
        player.name = (msg.name || player.name).slice(0, 24);
        player.color = msg.color || 0x4a90c0;
        const room = getOrCreateRoom(roomId);
        room.add(playerId);

        // Send list of existing players to the newcomer
        const existing = [];
        for (const pid of room) {
          if (pid === playerId) continue;
          const p = players.get(pid);
          if (p) {
            existing.push({
              id: p.id,
              name: p.name,
              color: p.color,
              x: p.x, z: p.z, yaw: p.yaw,
              pose: p.pose,
            });
          }
        }
        sendTo(playerId, { type: 'roomState', players: existing });

        // Notify others
        broadcastToRoom(roomId, {
          type: 'join',
          id: playerId,
          name: player.name,
          color: player.color,
          x: player.x, z: player.z, yaw: player.yaw,
        }, playerId);

        console.log(`[room] ${playerId} joined "${roomId}" (${room.size} players)`);
        break;
      }

      case 'state': {
        // { type:'state', x, z, yaw, pose: {...} }
        // Quick position+pose update — broadcast to others in room
        if (!player.room) break;
        player.x = msg.x;
        player.z = msg.z;
        player.yaw = msg.yaw;
        player.pose = msg.pose;
        broadcastToRoom(player.room, {
          type: 'state',
          id: playerId,
          x: msg.x, z: msg.z, yaw: msg.yaw,
          pose: msg.pose,
        }, playerId);
        break;
      }

      case 'attack': {
        // { type:'attack', kind: 'punch'|'mark'|'24fps'|'remate', targetId?, ... }
        if (!player.room) break;
        broadcastToRoom(player.room, {
          type: 'attack',
          id: playerId,
          kind: msg.kind,
          targetId: msg.targetId || null,
          punchType: msg.punchType || null,
          x: msg.x, z: msg.z,
        }, playerId);
        break;
      }

      case 'damage': {
        // Player claims they damaged a dummy. We trust the client (auth-light beta).
        // { type:'damage', targetType:'dummy', targetId: 'd-id', amount, hitTarget }
        if (!player.room) break;
        broadcastToRoom(player.room, {
          type: 'damage',
          fromId: playerId,
          targetType: msg.targetType,
          targetId: msg.targetId,
          amount: msg.amount,
          hitTarget: msg.hitTarget || null,
        }, playerId);
        break;
      }

      case 'chat': {
        if (!player.room) break;
        const text = (msg.text || '').slice(0, 200);
        broadcastToRoom(player.room, {
          type: 'chat',
          id: playerId,
          name: player.name,
          text,
        });
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
    if (player.room) {
      const room = rooms.get(player.room);
      if (room) {
        room.delete(playerId);
        broadcastToRoom(player.room, { type: 'leave', id: playerId });
        if (room.size === 0) rooms.delete(player.room);
      }
    }
    players.delete(playerId);
  });

  ws.on('error', () => {
    try { ws.close(); } catch (e) {}
  });
});

// ============================================================
// Cleanup loop — drop dead connections
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [pid, p] of players) {
    if (now - p.lastSeen > 60_000) {
      console.log(`[clean] Dropping stale ${pid}`);
      try { p.ws.close(); } catch (e) {}
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`JJK Multiplayer Server listening on :${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check:       http://localhost:${PORT}/health`);
});
