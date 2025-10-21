const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  rooms,
  getRoom,
  removeClient,
  broadcast,
  sendEvent,
  generateClientId
} = require('./lib/rooms');

const PORT = process.env.PORT || 3434;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, 'key.pem');
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, 'cert.pem');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const publicDir = path.join(__dirname, 'public');
  let safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (pathname !== '/index.html') {
        serveStatic(req, res, '/index.html');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    const stream = fs.createReadStream(safePath);
    res.writeHead(200, { 'Content-Type': getMimeType(safePath) });
    stream.pipe(res);
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function loadTlsCredentials() {
  try {
    if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
      return null;
    }
    return {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH)
    };
  } catch (err) {
    console.warn(`Unable to load TLS credentials: ${err.message}`);
    return null;
  }
}

// Minimal router handling SSE, signaling, and static assets.
const requestListener = async (req, res) => {
  const scheme = req.socket.encrypted ? 'https' : 'http';
  const parsedUrl = new URL(req.url, `${scheme}://${req.headers.host}`);

  if (req.method === 'GET' && parsedUrl.pathname === '/events') {
    handleEventStream(req, res, parsedUrl);
    return;
  }

  if (req.method === 'POST' && (parsedUrl.pathname === '/join' || parsedUrl.pathname === '/api/join')) {
    await handleJoin(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/signal') {
    await handleSignal(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/leave') {
    await handleLeave(req, res);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  serveStatic(req, res, pathname);
};

const tlsCredentials = loadTlsCredentials();
const server = tlsCredentials
  ? https.createServer(tlsCredentials, requestListener)
  : http.createServer(requestListener);
const protocol = tlsCredentials ? 'https' : 'http';

async function handleJoin(req, res) {
  try {
    const { room, name } = await parseBody(req);
    const roomId = room ? String(room).trim() : '';
    const userName = name ? String(name).trim().slice(0, 64) : '';
    if (!roomId || !userName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing room or name' }));
      return;
    }

    const roomData = getRoom(roomId);
    const existingPeers = [];
    for (const [id, client] of roomData.clients.entries()) {
      existingPeers.push({ clientId: id, name: client.name });
    }

    // Register caller before responding so they receive downstream SSE events.
    const clientId = generateClientId();
    roomData.clients.set(clientId, { name: userName, res: null });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clientId, room: roomId, peers: existingPeers }));

    broadcast(roomId, clientId, 'peer-joined', { clientId, name: userName });
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

async function handleSignal(req, res) {
  try {
    const { room, from, target, data } = await parseBody(req);
    if (!room || !from || !target || !data) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields' }));
      return;
    }

    const roomData = rooms.get(String(room));
    if (!roomData) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room not found' }));
      return;
    }

    const recipient = roomData.clients.get(String(target));
    if (!recipient || !recipient.res) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recipient unavailable' }));
      return;
    }

    // Push the signaling payload through the recipient's SSE stream.
    sendEvent(recipient.res, 'signal', { from, data });

    res.writeHead(204);
    res.end();
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

async function handleLeave(req, res) {
  try {
    const { room, clientId } = await parseBody(req);
    if (!room || !clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing room or clientId' }));
      return;
    }
    removeClient(String(room), String(clientId));
    res.writeHead(204);
    res.end();
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

function handleEventStream(req, res, parsedUrl) {
  const roomId = parsedUrl.searchParams.get('room');
  const clientId = parsedUrl.searchParams.get('clientId');

  if (!roomId || !clientId) {
    res.writeHead(400);
    res.end('Missing room or clientId');
    return;
  }

  const roomData = rooms.get(String(roomId));
  if (!roomData || !roomData.clients.has(String(clientId))) {
    res.writeHead(404);
    res.end('Client not registered in room');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  const client = roomData.clients.get(String(clientId));
  client.res = res;

  // Periodic heartbeat keeps proxies from timing out the SSE connection.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const currentRoom = rooms.get(String(roomId));
    if (!currentRoom) return;
    const entry = currentRoom.clients.get(String(clientId));
    if (!entry) return;
    // Tear down the client slot and notify peers when browser disconnects.
    currentRoom.clients.delete(String(clientId));
    if (currentRoom.clients.size === 0) {
      rooms.delete(String(roomId));
    } else {
      broadcast(String(roomId), String(clientId), 'peer-left', { clientId: String(clientId) });
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${protocol}://0.0.0.0:${PORT}`);
  if (!tlsCredentials) {
    console.warn('TLS credentials not found; running without HTTPS. Secure contexts are required for WebRTC in most browsers.');
  }
});
