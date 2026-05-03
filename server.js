// ============================================================
// JJK 24FRAMES — Multiplayer WebSocket Server
// ============================================================
// Tested on Node.js 18+. Run with: node server.js
// Listens on PORT env var (default 8080).
// Behind a reverse proxy (Nginx/Caddy) for HTTPS in production.
// ============================================================

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ============================================================
// Game state — kept in memory
// ============================================================
// Players: Map<playerId, { ws, name, room, x, z, yaw, pose, color, lastSeen }>
const players = new Map();
// Rooms: Map<roomId, Set<playerId>>
const rooms = new Map();

let nextPlayerId = 1;

function genPlayerId() { return 'p' + (nextPlayerId++); }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, message, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const pid of room) {
    if (pid === excludeId) continue;
    const p = players.get(pid);
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
