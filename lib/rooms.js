const crypto = require('crypto');

/**
 * rooms = Map<
 *   roomId,
 *   {
 *     clients: Map<
 *       clientId,
 *       { name: string, res: http.ServerResponse | null }
 *     >
 *   }
 * >
 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Map() });
  }
  return rooms.get(roomId);
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(roomId, excludeClientId, event, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, client] of room.clients.entries()) {
    if (id === excludeClientId) continue;
    if (client.res) {
      sendEvent(client.res, event, payload);
    }
  }
}

function generateClientId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function removeClient(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const client = room.clients.get(clientId);
  if (!client) return;

  if (client.res) {
    try {
      client.res.end();
    } catch (err) {
      // Ignore errors during teardown
    }
  }

  room.clients.delete(clientId);
  if (room.clients.size === 0) {
    rooms.delete(roomId);
  } else {
    broadcast(roomId, clientId, 'peer-left', { clientId });
  }
}

module.exports = {
  rooms,
  getRoom,
  removeClient,
  broadcast,
  sendEvent,
  generateClientId
};
