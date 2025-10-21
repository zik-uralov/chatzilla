const ICE_CONFIGURATION = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const joinPanel = document.getElementById('join-panel');
const chatPanel = document.getElementById('chat-panel');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const leaveButton = document.getElementById('leave-button');
const statusLabel = document.getElementById('status-label');
const roomLabel = document.getElementById('room-label');
const peerList = document.getElementById('peer-list');
const messageFeed = document.getElementById('message-feed');
const messageTemplate = document.getElementById('message-template');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const mediaGrid = document.getElementById('media-grid');
const localVideo = document.getElementById('local-video');
const localTile = document.querySelector('.media__tile--self');
const localLabel = localTile ? localTile.querySelector('.media__label') : null;

const state = {
  clientId: null,
  roomId: null,
  name: null,
  localStream: null,
  eventSource: null,
  peers: new Map()
};

joinForm.addEventListener('submit', handleJoin);
leaveButton.addEventListener('click', () => {
  leaveRoom();
});
messageForm.addEventListener('submit', handleMessageSubmit);
window.addEventListener('beforeunload', () => {
  if (!state.clientId || !state.roomId) return;
  const payload = JSON.stringify({ room: state.roomId, clientId: state.clientId });
  navigator.sendBeacon('/leave', new Blob([payload], { type: 'application/json' }));
});

async function handleJoin(event) {
  event.preventDefault();
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) return;

  toggleJoinForm(true);
  setStatus('Connecting…', 'status--idle');

  try {
    const response = await fetch('/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, room })
    });

    if (!response.ok) {
      const errorBody = await safeParseJson(response);
      throw new Error(errorBody?.error ?? `Server returned ${response.status}`);
    }

    const data = await response.json();
    state.clientId = data.clientId;
    state.roomId = data.room;
    state.name = name;
    state.peers.clear();
    updateLocalMediaLabel();

    for (const peer of data.peers) {
      state.peers.set(peer.clientId, createPeerEntry({ id: peer.clientId, name: peer.name }));
    }

    await ensureLocalStream();

    openChatPanel();
    renderPeerList();
    updateMessageFormAvailability();

    await startEventStream();

    for (const peer of data.peers) {
      await setupPeerConnection(peer.clientId, { name: peer.name, initiator: true });
    }

    appendSystemMessage(`You joined room ${state.roomId}.`);
    setStatus('Connected. Waiting for peers…', 'status--connected');
  } catch (error) {
    console.error('[join] failed', error);
    setStatus(`Failed to join: ${error.message}`, 'status--error');
    toggleJoinForm(false);
  }
}

async function startEventStream() {
  if (!state.roomId || !state.clientId) return;

  if (state.eventSource) {
    state.eventSource.close();
  }

  const url = new URL('/events', window.location.origin);
  url.searchParams.set('room', state.roomId);
  url.searchParams.set('clientId', state.clientId);

  state.eventSource = new EventSource(url.toString());

  state.eventSource.addEventListener('peer-joined', event => {
    const payload = safeJson(event.data);
  if (!payload || payload.clientId === state.clientId) return;

  const peer = ensurePeer(payload.clientId);
  peer.name = payload.name ?? peer.name;
  updatePeerMediaLabel(peer);
  renderPeerList();
  appendSystemMessage(`${peer.name} joined the room.`);
  setupPeerConnection(payload.clientId, { name: peer.name, initiator: false }).catch(err => {
    console.error('[peer-joined] setup failed', err);
  });
  });

  state.eventSource.addEventListener('peer-left', event => {
    const payload = safeJson(event.data);
    if (!payload || payload.clientId === state.clientId) return;
    const peer = state.peers.get(payload.clientId);
    const displayName = peer?.name ?? 'Peer';
    appendSystemMessage(`${displayName} left the room.`);
    teardownPeer(payload.clientId);
  });

  state.eventSource.addEventListener('signal', event => {
    const payload = safeJson(event.data);
    if (!payload || payload.from === state.clientId) return;
    handleSignal(payload.from, payload.data).catch(err => {
      console.error('[signal] handler error', err);
    });
  });

  state.eventSource.onopen = () => {
    setStatus('Signal channel connected.', 'status--connected');
  };

  state.eventSource.onerror = () => {
    setStatus('Connection interrupted. Attempting to reconnect…', 'status--idle');
  };
}

async function setupPeerConnection(peerId, { name, initiator = false } = {}) {
  const peer = ensurePeer(peerId);
  peer.name = name ?? peer.name;
  updatePeerMediaLabel(peer);

  if (peer.pc) {
    if (initiator && peer.pc.signalingState === 'stable') {
      await createAndSendOffer(peerId, peer);
    }
    return peer;
  }

  await ensureLocalStream();

  const pc = new RTCPeerConnection(ICE_CONFIGURATION);
  peer.pc = pc;

  state.localStream.getTracks().forEach(track => {
    pc.addTrack(track, state.localStream);
  });

  pc.onicecandidate = event => {
    if (event.candidate) {
      sendSignal(peerId, { candidate: event.candidate }).catch(err => {
        console.error('[ice] send candidate failed', err);
      });
    }
  };

  pc.ontrack = event => {
    attachRemoteStream(peer, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      appendSystemMessage(`${peer.name} connection lost.`);
      peer.dataChannelReady = false;
      updateMessageFormAvailability();
      renderPeerList();
    }
  };

  if (initiator) {
    const channel = pc.createDataChannel('chat');
    configureDataChannel(peer, channel);
  } else {
    pc.ondatachannel = event => {
      configureDataChannel(peer, event.channel);
    };
  }

  renderPeerList();

  if (initiator) {
    await createAndSendOffer(peerId, peer);
  }

  return peer;
}

async function handleSignal(peerId, payload) {
  const peer = await setupPeerConnection(peerId, { initiator: false });
  if (!peer || !peer.pc) return;

  if (payload.description) {
    const description = payload.description;
    await peer.pc.setRemoteDescription(description);

    if (description.type === 'offer') {
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await sendSignal(peerId, { description: peer.pc.localDescription });
    }
  } else if (payload.candidate) {
    try {
      await peer.pc.addIceCandidate(payload.candidate);
    } catch (error) {
      console.warn('[signal] addIceCandidate failed', error);
    }
  }
}

async function createAndSendOffer(peerId, peer) {
  if (!peer.pc) return;
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  await sendSignal(peerId, { description: peer.pc.localDescription });
}

function configureDataChannel(peer, channel) {
  peer.dataChannel = channel;
  channel.onopen = () => {
    peer.dataChannelReady = true;
    appendSystemMessage(`${peer.name} is ready to chat.`);
    updateMessageFormAvailability();
    renderPeerList();
  };
  channel.onclose = () => {
    peer.dataChannelReady = false;
    updateMessageFormAvailability();
    renderPeerList();
  };
  channel.onerror = event => {
    console.error('[dataChannel] error', event);
  };
  channel.onmessage = event => {
    const payload = safeJson(event.data);
    if (!payload) return;
    if (payload.type === 'chat') {
      appendMessage({
        author: payload.name ?? 'Peer',
        text: payload.text ?? '',
        timestamp: payload.timestamp,
        isSelf: false
      });
    }
  };
}

const SIGNAL_RETRY_LIMIT = 5;
const SIGNAL_RETRY_DELAY_MS = 250;

async function sendSignal(target, data, attempt = 0) {
  if (!state.roomId || !state.clientId) return;
  const response = await fetch('/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: state.roomId,
      from: state.clientId,
      target,
      data
    })
  });
  if (response.ok) {
    return;
  }

  if (response.status === 409 && attempt < SIGNAL_RETRY_LIMIT) {
    await delay(SIGNAL_RETRY_DELAY_MS * (attempt + 1));
    return sendSignal(target, data, attempt + 1);
  }

  const body = await safeParseJson(response);
  throw new Error(body?.error ?? `Signal failed with status ${response.status}`);
}

function ensurePeer(peerId) {
  if (!state.peers.has(peerId)) {
    state.peers.set(peerId, createPeerEntry({ id: peerId }));
  }
  const peer = state.peers.get(peerId);
  peer.id = peerId;
  updatePeerMediaLabel(peer);
  return peer;
}

function createPeerEntry({ id = null, name = 'Peer' } = {}) {
  return {
    id,
    name,
    pc: null,
    dataChannel: null,
    dataChannelReady: false,
    remoteStream: null,
    videoEl: null,
    mediaLabel: null,
    tileEl: null
  };
}

function teardownPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  if (peer.dataChannel) {
    try {
      peer.dataChannel.close();
    } catch (err) {
      console.warn('[teardown] dataChannel close failed', err);
    }
  }
  if (peer.pc) {
    peer.pc.close();
  }
  if (peer.videoEl) {
    peer.videoEl.srcObject = null;
  }
  if (peer.tileEl) {
    peer.tileEl.remove();
  }
  peer.videoEl = null;
  peer.mediaLabel = null;
  peer.tileEl = null;
  peer.remoteStream = null;
  state.peers.delete(peerId);
  renderPeerList();
  updateMessageFormAvailability();
}

function handleMessageSubmit(event) {
  event.preventDefault();
  if (messageInput.disabled) return;
  const text = messageInput.value.trim();
  if (!text) return;

  const timestamp = Date.now();
  appendMessage({ author: state.name ?? 'You', text, timestamp, isSelf: true });
  messageInput.value = '';

  const payload = JSON.stringify({
    type: 'chat',
    text,
    name: state.name,
    timestamp
  });

  for (const peer of state.peers.values()) {
    if (peer.dataChannel && peer.dataChannelReady) {
      try {
        peer.dataChannel.send(payload);
      } catch (err) {
        console.warn('[chat] failed to send to peer', err);
      }
    }
  }
}

function appendMessage({ author, text, timestamp = Date.now(), isSelf = false, isSystem = false }) {
  const clone = messageTemplate.content.firstElementChild.cloneNode(true);
  const authorEl = clone.querySelector('.message__author');
  const timeEl = clone.querySelector('.message__time');
  const bodyEl = clone.querySelector('.message__body');

  authorEl.textContent = author;
  timeEl.textContent = formatTime(timestamp);
  bodyEl.textContent = text;

  if (isSelf) {
    clone.classList.add('message--self');
  }
  if (isSystem) {
    clone.classList.add('message--system');
  }

  messageFeed.append(clone);
  messageFeed.scrollTop = messageFeed.scrollHeight;
}

function appendSystemMessage(text) {
  appendMessage({ author: 'System', text, isSystem: true });
}

async function ensureLocalStream() {
  if (state.localStream) return state.localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      }
    });
    state.localStream = stream;
    if (localVideo) {
      localVideo.srcObject = stream;
      localVideo.muted = true;
      localVideo.play().catch(() => {
        /* Autoplay might be blocked; user interaction will resume. */
      });
    }
    return stream;
  } catch (error) {
    setStatus('Camera or microphone access denied. Reload to try again.', 'status--error');
    throw error;
  }
}

function leaveRoom() {
  if (!state.clientId || !state.roomId) {
    resetToJoin();
    return;
  }

  for (const peerId of Array.from(state.peers.keys())) {
    teardownPeer(peerId);
  }

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }
  if (localVideo) {
    localVideo.srcObject = null;
  }

  fetch('/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: state.roomId, clientId: state.clientId })
  }).catch(err => {
    console.warn('[leave] request failed', err);
  });

  appendSystemMessage('You left the room.');
  resetToJoin();
}

function resetToJoin() {
  state.clientId = null;
  state.roomId = null;
  state.name = null;
  messageFeed.innerHTML = '';
  peerList.innerHTML = '';
  roomLabel.textContent = '';
  setStatus('Waiting to connect…', 'status--idle');
  messageInput.value = '';
  messageInput.disabled = true;
  sendButton.disabled = true;
  joinPanel.classList.add('panel--active');
  chatPanel.classList.remove('panel--active');
  toggleJoinForm(false);
  updateLocalMediaLabel();
}

function openChatPanel() {
  roomLabel.textContent = `Room ${state.roomId}`;
  joinPanel.classList.remove('panel--active');
  chatPanel.classList.add('panel--active');
}

function toggleJoinForm(disabled) {
  for (const element of joinForm.elements) {
    element.disabled = disabled;
  }
}

function renderPeerList() {
  peerList.innerHTML = '';

  const selfItem = document.createElement('li');
  selfItem.classList.add('self');
  selfItem.textContent = `${state.name ?? 'You'} (you)`;
  peerList.append(selfItem);

  for (const [id, peer] of state.peers.entries()) {
    const item = document.createElement('li');
    item.textContent = peer.name ?? `Peer ${id.slice(0, 4)}`;
    const status = document.createElement('span');
    status.classList.add('peer-status');
    status.textContent = peer.dataChannelReady ? 'Chat ready' : 'Connecting…';
    item.append(status);
    peerList.append(item);
  }
}

function updateMessageFormAvailability() {
  const ready = Array.from(state.peers.values()).some(peer => peer.dataChannelReady);
  messageInput.disabled = !ready;
  sendButton.disabled = !ready;
}

function setStatus(text, modifierClass = 'status--idle') {
  statusLabel.textContent = text;
  statusLabel.classList.remove('status--idle', 'status--connected', 'status--error');
  statusLabel.classList.add(modifierClass);
}

function formatTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateLocalMediaLabel() {
  if (!localLabel) return;
  localLabel.textContent = state.name ? `${state.name} (you)` : 'You';
}

function ensurePeerMediaTile(peer) {
  if (!peer) return null;
  if (!mediaGrid) return null;
  if (!peer.tileEl) {
    const tile = document.createElement('div');
    tile.className = 'media__tile';
    tile.dataset.peerId = peer.id ?? '';
    const video = document.createElement('video');
    video.className = 'media__video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    const label = document.createElement('span');
    label.className = 'media__label';
    tile.append(video, label);
    mediaGrid.append(tile);
    peer.videoEl = video;
    peer.mediaLabel = label;
    peer.tileEl = tile;
  }
  updatePeerMediaLabel(peer);
  return peer;
}

function attachRemoteStream(peer, stream) {
  if (!stream) return;
  ensurePeerMediaTile(peer);
  peer.remoteStream = stream;
  if (peer.videoEl && peer.videoEl.srcObject !== stream) {
    peer.videoEl.srcObject = stream;
    peer.videoEl.play().catch(() => {
      /* Some browsers require user interaction to autoplay; ignore */
    });
  }
}

function updatePeerMediaLabel(peer) {
  if (peer?.mediaLabel) {
    peer.mediaLabel.textContent = peer.name ?? 'Peer';
  }
  if (peer?.tileEl) {
    peer.tileEl.dataset.peerId = peer.id ?? '';
  }
}
