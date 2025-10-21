const { getRoom, generateClientId, broadcast } = require('../lib/rooms');

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (err) {
      return {};
    }
  }
  return body;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { room, name } = normalizeBody(req.body);
  const roomId = room ? String(room).trim() : '';
  const userName = name ? String(name).trim().slice(0, 64) : '';

  if (!roomId || !userName) {
    res.status(400).json({ error: 'Missing room or name' });
    return;
  }

  const roomData = getRoom(roomId);
  const existingPeers = [];
  for (const [id, client] of roomData.clients.entries()) {
    existingPeers.push({ clientId: id, name: client.name });
  }

  const clientId = generateClientId();
  roomData.clients.set(clientId, { name: userName, res: null });

  res.status(200).json({ clientId, room: roomId, peers: existingPeers });

  broadcast(roomId, clientId, 'peer-joined', { clientId, name: userName });
}

module.exports = handler;
module.exports.default = handler;
