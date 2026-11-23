/**
 * server.js — Serveur Express + Socket.io pour la salle d'attente musicale
 * et la signalisation WebRTC temps réel (prêt pour déploiement Render).
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures
const PURGE_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket'],
  allowEIO3: false,
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7
});

// Middlewares Express
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/**
 * Stockage en mémoire des salles actives.
 */
const rooms = new Map();

function generateRoomId() {
  const raw = uuidv4().replace(/-/g, '').slice(0, 10);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 10)}`;
}

function isAuthorizedHost(room, hostToken) {
  return Boolean(room && hostToken && room.hostToken && hostToken === room.hostToken);
}

function isSameRoomPeer(socket, targetSocketId) {
  const roomId = socket.data?.roomId;
  if (!roomId || !targetSocketId) return false;
  const targetSocket = io.sockets.sockets.get(targetSocketId);
  return Boolean(targetSocket && targetSocket.data?.roomId === roomId);
}

/**
 * Sérialise une salle pour les réponses HTTP / Socket sans jamais exposer hostToken.
 */
function serializeRoom(room) {
  return {
    id: room.id,
    title: room.title,
    hostName: room.hostName,
    status: room.status,
    createdAt: room.createdAt,
    waitingCount: room.waitingParticipants.size,
    roomCount: room.roomParticipants.size,
    waitingParticipants: Array.from(room.waitingParticipants.values()),
    roomParticipants: Array.from(room.roomParticipants.values()),
    messages: room.messages
  };
}

// Purge périodique des salles vides inactives depuis plus de 2 heures
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const isEmpty = room.waitingParticipants.size === 0 && room.roomParticipants.size === 0;
    if (isEmpty && now - room.lastActiveAt > ROOM_IDLE_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}, PURGE_INTERVAL_MS).unref();

// ============================================================================
// ROUTES HTTP & API REST
// ============================================================================

/**
 * GET /health — Endpoint de surveillance Render.
 */
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime()
  });
});

/**
 * GET /api/ice-servers — Fournit les serveurs STUN (et TURN si configurés).
 */
app.get('/api/ice-servers', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];

  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

/**
 * POST /api/rooms — Crée une nouvelle salle de réunion et retourne hostToken au créateur.
 */
app.post('/api/rooms', (req, res) => {
  const { title, hostName } = req.body || {};
  const roomId = generateRoomId();
  const hostToken = uuidv4();

  const room = {
    id: roomId,
    title: (title || 'Réunion').trim().slice(0, 80),
    hostName: (hostName || 'Hôte').trim().slice(0, 40),
    hostToken,
    status: 'waiting',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    waitingParticipants: new Map(),
    roomParticipants: new Map(),
    messages: [],
    roomMessages: [],
    whiteboardHistory: [],
    whiteboardOpen: false,
    studio3d: {
      open: false,
      modelType: 'arduino',
      glbData: null,
      fileName: '',
      explode: 0,
      pins: [],
      camera: null
    }
  };

  rooms.set(roomId, room);

  res.status(201).json({
    roomId,
    title: room.title,
    waitingUrl: `/wait/${roomId}`,
    roomUrl: `/room/${roomId}`,
    hostToken
  });
});

/**
 * GET /api/rooms/:roomId — Récupère l'état d'une salle existante (sans hostToken).
 */
app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Salle introuvable' });
  }
  return res.json(serializeRoom(room));
});

// Routes pages HTML
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/wait/:roomId', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'wait.html'));
});

app.get('/room/:roomId', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
});

// ============================================================================
// SIGNALISATION SOCKET.IO (SALLE D'ATTENTE + WEBRTC)
// ============================================================================

io.on('connection', (socket) => {
  socket.data = {
    roomId: null,
    mode: null,
    isHost: false
  };

  // --------------------------------------------------------------------------
  // 1. SALLE D'ATTENTE
  // --------------------------------------------------------------------------

  socket.on('join-wait', ({ roomId, name, hostToken } = {}) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', { message: 'Cette salle n\'existe pas ou a expiré.' });
      return;
    }

    const verifiedHost = isAuthorizedHost(room, hostToken);
    const waitChannel = `wait:${roomId}`;
    socket.join(waitChannel);
    socket.data = { roomId, mode: 'wait', isHost: verifiedHost };
    room.lastActiveAt = Date.now();

    const participant = {
      socketId: socket.id,
      name: (name || 'Participant').trim().slice(0, 40),
      isHost: verifiedHost,
      joinedAt: Date.now()
    };

    room.waitingParticipants.set(socket.id, participant);

    socket.emit('wait-state', {
      ...serializeRoom(room),
      selfIsHost: verifiedHost
    });

    io.to(waitChannel).emit(
      'wait-participants',
      Array.from(room.waitingParticipants.values())
    );

    if (room.status === 'started') {
      socket.emit('meeting-started', {
        roomId,
        redirectUrl: `/room/${roomId}`
      });
    }
  });

  socket.on('wait-message', ({ roomId, name, message } = {}) => {
    const room = rooms.get(roomId);
    if (!room || !message || !message.trim()) return;

    room.lastActiveAt = Date.now();
    const msg = {
      id: uuidv4().slice(0, 8),
      name: (name || 'Participant').trim().slice(0, 40),
      message: message.trim().slice(0, 200),
      time: Date.now()
    };

    room.messages.push(msg);
    if (room.messages.length > 50) room.messages.shift();

    io.to(`wait:${roomId}`).emit('wait-message', msg);
  });

  socket.on('start-meeting', ({ roomId, hostToken } = {}) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', { message: 'Salle introuvable.' });
      return;
    }

    if (!isAuthorizedHost(room, hostToken) && !socket.data?.isHost) {
      socket.emit('room-error', { message: 'Action réservée à l’hôte.' });
      return;
    }

    room.status = 'started';
    room.lastActiveAt = Date.now();

    io.to(`wait:${roomId}`).emit('meeting-started', {
      roomId,
      title: room.title,
      redirectUrl: `/room/${roomId}`
    });
  });

  // --------------------------------------------------------------------------
  // 2. SALLE VIDÉO & SIGNALISATION WEBRTC
  // --------------------------------------------------------------------------

  socket.on('join-room', ({ roomId, name, hostToken, mediaState } = {}) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room-error', { message: 'Cette salle n\'existe pas ou a expiré.' });
      return;
    }

    const verifiedHost = isAuthorizedHost(room, hostToken);
    const roomChannel = `room:${roomId}`;
    socket.join(roomChannel);
    socket.data = { roomId, mode: 'room', isHost: verifiedHost };
    room.lastActiveAt = Date.now();

    const existingPeers = Array.from(room.roomParticipants.values());

    const participant = {
      socketId: socket.id,
      name: (name || 'Participant').trim().slice(0, 40),
      isHost: verifiedHost,
      handRaised: false,
      mediaState: {
        audio: mediaState?.audio ?? true,
        video: mediaState?.video ?? true,
        screen: false
      },
      joinedAt: Date.now()
    };

    room.roomParticipants.set(socket.id, participant);

    socket.emit('room-joined', {
      roomId,
      title: room.title,
      selfId: socket.id,
      selfIsHost: verifiedHost,
      peers: existingPeers,
      messages: room.roomMessages,
      whiteboardHistory: room.whiteboardHistory,
      whiteboardOpen: room.whiteboardOpen,
      studio3d: room.studio3d
    });

    socket.to(roomChannel).emit('user-joined', participant);
  });

  socket.on('offer', ({ to, offer } = {}) => {
    if (!offer || !isSameRoomPeer(socket, to)) return;
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer } = {}) => {
    if (!answer || !isSameRoomPeer(socket, to)) return;
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate } = {}) => {
    if (!candidate || !isSameRoomPeer(socket, to)) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('media-state-change', ({ roomId, audio, video, screen } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    const participant = room.roomParticipants.get(socket.id);
    if (!participant) return;

    participant.mediaState = {
      audio: Boolean(audio),
      video: Boolean(video),
      screen: Boolean(screen)
    };

    socket.to(`room:${roomId}`).emit('peer-media-state', {
      socketId: socket.id,
      mediaState: participant.mediaState
    });
  });

  socket.on('hand-state-change', ({ roomId, handRaised } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    const participant = room.roomParticipants.get(socket.id);
    if (!participant) return;

    participant.handRaised = Boolean(handRaised);
    socket.to(`room:${roomId}`).emit('peer-hand-state', {
      socketId: socket.id,
      handRaised: participant.handRaised
    });
  });

  socket.on('room-reaction', ({ roomId, name, emoji } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !emoji) return;

    io.to(`room:${roomId}`).emit('room-reaction', {
      id: uuidv4().slice(0, 8),
      senderId: socket.id,
      name: (name || 'Participant').trim().slice(0, 40),
      emoji: String(emoji).slice(0, 8)
    });
  });

  socket.on('host-mute-peer', ({ roomId, targetSocketId, hostToken } = {}) => {
    const room = rooms.get(roomId);
    if (!room || !targetSocketId) return;
    if (!isAuthorizedHost(room, hostToken) && !socket.data?.isHost) {
      socket.emit('room-error', { message: 'Action réservée à l’hôte.' });
      return;
    }
    if (!room.roomParticipants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('force-mute');
  });

  socket.on('host-kick-peer', ({ roomId, targetSocketId, hostToken } = {}) => {
    const room = rooms.get(roomId);
    if (!room || !targetSocketId) return;
    if (!isAuthorizedHost(room, hostToken) && !socket.data?.isHost) {
      socket.emit('room-error', { message: 'Action réservée à l’hôte.' });
      return;
    }
    if (!room.roomParticipants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('kicked-from-room', {
      reason: 'Vous avez été exclu de la réunion par l’hôte.'
    });

    room.roomParticipants.delete(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.leave(`room:${roomId}`);
      targetSocket.data = { roomId: null, mode: null, isHost: false };
    }

    io.to(`room:${roomId}`).emit('user-left', {
      socketId: targetSocketId
    });
  });

  socket.on('room-chat', ({ roomId, name, message } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !message || !message.trim()) return;

    room.lastActiveAt = Date.now();
    const chatMsg = {
      id: uuidv4().slice(0, 8),
      senderId: socket.id,
      name: (name || 'Participant').trim().slice(0, 40),
      message: message.trim().slice(0, 500),
      time: Date.now()
    };

    room.roomMessages.push(chatMsg);
    if (room.roomMessages.length > 50) room.roomMessages.shift();

    io.to(`room:${roomId}`).emit('room-chat', chatMsg);
  });

  // --------------------------------------------------------------------------
  // 2B. TABLEAU BLANC COLLABORATIF (WHITEBOARD)
  // --------------------------------------------------------------------------

  socket.on('wb-draw', ({ roomId, action } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !action) return;

    room.lastActiveAt = Date.now();
    room.whiteboardHistory.push(action);
    if (room.whiteboardHistory.length > 2000) {
      room.whiteboardHistory.shift();
    }

    socket.to(`room:${roomId}`).emit('wb-draw', action);
  });

  socket.on('wb-clear', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.whiteboardHistory = [];
    io.to(`room:${roomId}`).emit('wb-clear');
  });

  socket.on('wb-open', ({ roomId, name } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.whiteboardOpen = true;
    io.to(`room:${roomId}`).emit('wb-state-change', {
      open: true,
      openedBy: (name || 'Un participant').trim().slice(0, 40)
    });
  });

  socket.on('wb-close', ({ roomId, name } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.whiteboardOpen = false;
    io.to(`room:${roomId}`).emit('wb-state-change', {
      open: false,
      closedBy: (name || 'Un participant').trim().slice(0, 40)
    });
  });

  socket.on('wb-toggle', ({ roomId, name, isOpen } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.whiteboardOpen = Boolean(isOpen);
    io.to(`room:${roomId}`).emit('wb-state-change', {
      open: room.whiteboardOpen,
      openedBy: room.whiteboardOpen ? (name || 'Un participant').trim().slice(0, 40) : undefined,
      closedBy: !room.whiteboardOpen ? (name || 'Un participant').trim().slice(0, 40) : undefined
    });
  });

  // --------------------------------------------------------------------------
  // 2C. STUDIO 3D COLLABORATIF (THREE.JS)
  // --------------------------------------------------------------------------

  socket.on('3d-state-change', ({ roomId, open, name } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.studio3d.open = Boolean(open);
    io.to(`room:${roomId}`).emit('3d-state-change', {
      open: room.studio3d.open,
      openedBy: (name || 'Un participant').trim().slice(0, 40)
    });
  });

  socket.on('3d-select-model', ({ roomId, modelType, glbData = null, fileName = '' } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !modelType) return;

    room.lastActiveAt = Date.now();
    room.studio3d.modelType = String(modelType).slice(0, 40);
    room.studio3d.glbData = glbData || null;
    room.studio3d.fileName = String(fileName || '').slice(0, 120);
    room.studio3d.explode = 0;
    room.studio3d.pins = [];

    socket.to(`room:${roomId}`).emit('3d-select-model', {
      modelType: room.studio3d.modelType,
      glbData: room.studio3d.glbData,
      fileName: room.studio3d.fileName
    });
  });

  socket.on('3d-camera-sync', ({ roomId, position, target } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !position || !target) return;

    room.studio3d.camera = { position, target };
    socket.to(`room:${roomId}`).emit('3d-camera-sync', { position, target });
  });

  socket.on('3d-explode', ({ roomId, value } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.studio3d.explode = Math.max(0, Math.min(100, Number(value) || 0));
    socket.to(`room:${roomId}`).emit('3d-explode', { value: room.studio3d.explode });
  });

  socket.on('3d-add-pin', ({ roomId, pin } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId || !pin) return;

    room.lastActiveAt = Date.now();
    room.studio3d.pins.push(pin);
    if (room.studio3d.pins.length > 50) room.studio3d.pins.shift();
    socket.to(`room:${roomId}`).emit('3d-add-pin', pin);
  });

  socket.on('3d-clear-pins', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (!room || socket.data?.roomId !== roomId) return;

    room.lastActiveAt = Date.now();
    room.studio3d.pins = [];
    io.to(`room:${roomId}`).emit('3d-clear-pins');
  });

  // --------------------------------------------------------------------------
  // 3. DÉPART & DÉCONNEXION
  // --------------------------------------------------------------------------

  function handleLeave() {
    const { roomId, mode } = socket.data || {};
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.lastActiveAt = Date.now();

    if (mode === 'wait') {
      room.waitingParticipants.delete(socket.id);
      socket.leave(`wait:${roomId}`);
      io.to(`wait:${roomId}`).emit(
        'wait-participants',
        Array.from(room.waitingParticipants.values())
      );
    } else if (mode === 'room') {
      room.roomParticipants.delete(socket.id);
      socket.leave(`room:${roomId}`);
      socket.to(`room:${roomId}`).emit('user-left', {
        socketId: socket.id
      });
    }

    socket.data = { roomId: null, mode: null, isHost: false };
  }

  socket.on('leave-room', handleLeave);
  socket.on('disconnect', handleLeave);
});

// ============================================================================
// DÉMARRAGE DU SERVEUR
// ============================================================================

server.listen(PORT, () => {
  console.log(`\n🚀 MeetLite prêt sur http://localhost:${PORT}`);
  console.log(`   Express + Socket.io (Salle d'attente + Signalisation WebRTC)\n`);
});
