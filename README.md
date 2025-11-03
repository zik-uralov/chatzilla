# ChatZilla

ChatZilla is a lightweight WebRTC group chat room that ships as a single Node.js process. It serves a modern front end, manages peer-to-peer negotiation, and relays signaling events so browsers can connect directly for audio, video, and text chat. The server purposely avoids external dependencies—everything runs on top of the Node.js standard library—making it easy to deploy to platforms such as Vercel or any bare VM.

## Features
- Multi-party rooms: join any room code and automatically discover everyone who is already connected.
- Rich client experience: responsive UI with participant list, live message feed, and dynamic media tiles for each peer.
- WebRTC media + data: audio/video streams are shared peer-to-peer while a data channel carries text chat.
- Server-Sent Events signaling: the Node server multiplexes signaling traffic over SSE, avoiding WebSocket infrastructure.
- Graceful lifecycle handling: automatic retries, heartbeats, and teardown keep rooms tidy when peers disconnect.
- Optional TLS: run locally over HTTPS (required by most browsers for WebRTC) by dropping a `key.pem` / `cert.pem` pair next to `index.js`.

## Architecture Overview
```
Browser UI ── fetch /join ─┐
                          ├── Node server (index.js)
Browser SSE /events  ─────┘
          │
          ▼
Peer-to-peer WebRTC mesh (audio, video, data channels)
```

The server published in `index.js` is responsible for:
1. Serving static assets from `public/`.
2. Exposing REST-style endpoints for joining (`POST /join`), leaving (`POST /leave`), and signaling (`POST /signal`).
3. Running an SSE stream (`GET /events?room={id}&clientId={id}`) that fans out room state changes and ICE/SDP payloads.
4. Tracking in-memory room membership via `lib/rooms.js`, including cleanup when peers disconnect or fail to negotiate.

Each browser:
1. Collects media with `getUserMedia`, then calls `/join` with a `room` code and display `name`.
2. Opens the SSE stream to receive `peer-joined`, `peer-left`, and `signal` events.
3. Establishes `RTCPeerConnection` instances for each peer, sending offers/answers and ICE candidates through `/signal`.
4. Uses a dedicated data channel per peer to share chat messages while video/audio travel across attached media tracks.

## Repository Layout
- `index.js` – main HTTP(S) server and minimal router.
- `lib/rooms.js` – in-memory room registry, client bookkeeping, and helper utilities.
- `public/` – front-end assets served directly to the browser.
  - `index.html` – single-page UI shell.
  - `app.js` – event handling, WebRTC orchestration, and chat logic.
  - `styles.css` – responsive styling for join + chat panels.
- `api/join.js` – serverless-friendly entry point that re-uses the same join logic (used when deploying to Vercel).
- `vercel.json` – configuration to run the Node handler on Vercel’s platform.

## Quick Start
1. Install Node.js 22 (matching the `engines` field in `package.json`).
2. Install dependencies (only dev tooling is needed, so this is optional): `npm install`.
3. Start the server: `npm start` (defaults to port `3434`).
4. Visit `http://localhost:3434` in two browser tabs, join the same room code, and begin chatting.

### Secure Local Tunnels
Browsers typically require HTTPS before allowing camera/microphone access. You have a few options:
- Provide `cert.pem` and `key.pem` files or point `TLS_CERT_PATH` / `TLS_KEY_PATH` at an existing certificate pair.
- Use a tunneling tool (example: `cloudflared tunnel --url http://localhost:3434`) to expose an HTTPS endpoint.

## Configuration
Environment variables:
- `PORT` – override the default `3434`.
- `TLS_KEY_PATH` – absolute path to a PEM-encoded private key (defaults to `./key.pem`).
- `TLS_CERT_PATH` – absolute path to a PEM-encoded certificate (defaults to `./cert.pem`).

Without valid TLS files, the server falls back to plain HTTP and prints a warning about WebRTC secure context requirements.

## API Contract
All endpoints accept/return JSON.

| Method | Path      | Description | Request Body | Response |
| ------ | --------- | ----------- | ------------ | -------- |
| POST   | `/join`   | Register the caller in a room and enumerate connected peers. | `{ "room": "my-room", "name": "Ada" }` | `200 OK` `{ "clientId": "...", "room": "my-room", "peers": [{ "clientId": "...", "name": "Grace" }] }` |
| GET    | `/events` | Establish an SSE stream for room events and signaling payloads. | Query params: `room`, `clientId` | `200 OK` event stream (`peer-joined`, `peer-left`, `signal`) |
| POST   | `/signal` | Relay SDP descriptions and ICE candidates to another peer. | `{ "room": "...", "from": "...", "target": "...", "data": { "description" | "candidate" } }` | `204 No Content` |
| POST   | `/leave`  | Explicitly leave a room to clean up server state. | `{ "room": "...", "clientId": "..." }` | `204 No Content` |

The SSE heartbeat sends `: ping` comments every 20 seconds to keep intermediaries from closing idle connections.

## Front-End Behavior
- **Join flow:** Disables the join form while awaiting `/join`, surfaces friendly status text, and re-enables the form on failure.
- **Media grid:** Tiles are created dynamically as peers connect; each video label shows the display name.
- **Chat:** Text messages appear in chronological order with timestamps formatted in the user’s locale.
- **Participant roster:** Always lists “You” at the top, followed by peers and their connection status.
- **Connection resiliency:** If the SSE transport errors, the UI updates the status to reflect reconnection attempts.

## Development Tips
- Logs from `npm start` show whether TLS is active and which port is bound.
- The UI runs as a standard static site—use your favorite dev server if you want hot reloading by pointing `/events`, `/signal`, etc. to the Node backend.
- Because room state lives in-memory, a server restart clears all active rooms; persistent storage would require extending `lib/rooms.js`.

## Deployment Notes
- Vercel users can deploy with the provided `vercel.json`; the server will respond from `index.js`.
- For self-hosting, run `node index.js` behind a reverse proxy that terminates TLS or supply certificates via the env vars listed above.
- Configure your hosting platform to keep the process warm—rooms disappear when the process stops because there is no database.

## Troubleshooting
- **Camera or microphone blocked:** The UI sets an error status if `getUserMedia` fails; ensure you are on HTTPS and grant permissions.
- **Peers never connect:** Check browser dev tools for network errors. Missing `/signal` responses or blocked SSE connections are common culprits when running behind restrictive proxies.
- **ICE candidates not exchanged:** Verify outbound UDP is allowed; swap the default STUN server if corporate networks block Google’s public STUN.

Enjoy chatting with ChatZilla!
