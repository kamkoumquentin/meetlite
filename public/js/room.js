/**
 * room.js — Visioconférence WebRTC native (architecture Mesh) + Socket.io
 *
 * Responsabilités :
 *  1. Capture média locale (getUserMedia avec fallback audio-only / écoute seule)
 *  2. Gestion des RTCPeerConnection et MediaStream distants via des Maps
 *  3. Signalisation WebRTC (offer, answer, ice-candidate + file d'attente ICE)
 *  4. Grille vidéo responsive (ajout / suppression propre des tuiles + avatars)
 *  5. Synchronisation temps réel des participants, chat avec badge non-lu et partage d'écran
 */

(function () {
  'use strict';

  // ==========================================================================
  // CONFIGURATION & ÉTAT GLOBAL
  // ==========================================================================

  const roomId = MeetCommon.getRoomIdFromPath();
  const hostToken = MeetCommon.getHostToken(roomId);
  let isHost = Boolean(hostToken) || MeetCommon.isHostFromQuery();
  let userName = MeetCommon.getUserName() || (isHost ? 'Hôte' : 'Participant');

  // Serveurs STUN par défaut (complétés dynamiquement via /api/ice-servers)
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  };
  let rtcConfig = { ...RTC_CONFIG };

  const socket = io({
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000
  });

  // Flux locaux
  let localStream = null;
  let screenStream = null;
  let audioEnabled = false;
  let videoEnabled = false;
  let screenEnabled = false;
  let handRaised = false;
  let unreadChatCount = 0;

  // État d'épinglage (Spotlight), détection de parole & enregistrement
  let pinnedTileId = null;
  let autoPinnedTileId = null;
  let sharedAudioContext = null;
  const audioMonitors = new Map();        // Map<id, { intervalId, source }>
  let hasJoinedRoom = false;

  let mediaRecorder = null;
  let recordDisplayStream = null;
  let recordAudioCtx = null;
  let recordTimerId = null;
  let recordedChunks = [];

  // Structures Map dédiées aux pairs WebRTC
  const peerConnections = new Map();      // Map<socketId, RTCPeerConnection>
  const remoteStreams = new Map();        // Map<socketId, MediaStream>
  const peerMetadata = new Map();         // Map<socketId, { name: string, isHost: boolean, mediaState: object }>
  const pendingIceCandidates = new Map(); // Map<socketId, RTCIceCandidateInit[]>

  // Références DOM
  const dom = {
    roomTitle: document.getElementById('roomTitle'),
    roomCodeTag: document.getElementById('roomCodeTag'),
    copyRoomLinkBtn: document.getElementById('copyRoomLinkBtn'),
    recIndicator: document.getElementById('recIndicator'),
    recTimer: document.getElementById('recTimer'),
    callTimer: document.getElementById('callTimer'),
    peerCountBadge: document.getElementById('peerCountBadge'),
    mediaAlert: document.getElementById('mediaAlert'),
    prejoinOverlay: document.getElementById('prejoinOverlay'),
    prejoinRoomCode: document.getElementById('prejoinRoomCode'),
    prejoinVideo: document.getElementById('prejoinVideo'),
    prejoinAvatar: document.getElementById('prejoinAvatar'),
    prejoinAvatarInitials: document.getElementById('prejoinAvatarInitials'),
    prejoinMicBar: document.getElementById('prejoinMicBar'),
    prejoinMicBtn: document.getElementById('prejoinMicBtn'),
    prejoinCamBtn: document.getElementById('prejoinCamBtn'),
    prejoinNameInput: document.getElementById('prejoinNameInput'),
    joinNowBtn: document.getElementById('joinNowBtn'),
    inviteModal: document.getElementById('inviteModal'),
    closeInviteBtn: document.getElementById('closeInviteBtn'),
    inviteWaitInput: document.getElementById('inviteWaitInput'),
    inviteDirectInput: document.getElementById('inviteDirectInput'),
    copyWaitInviteBtn: document.getElementById('copyWaitInviteBtn'),
    copyDirectInviteBtn: document.getElementById('copyDirectInviteBtn'),
    videoGrid: document.getElementById('videoGrid'),
    localTile: document.getElementById('localTile'),
    localPinBtn: document.getElementById('localPinBtn'),
    localHandBadge: document.getElementById('localHandBadge'),
    localVideo: document.getElementById('localVideo'),
    localAvatar: document.getElementById('localAvatar'),
    localAvatarInitials: document.getElementById('localAvatarInitials'),
    localNameLabel: document.getElementById('localNameLabel'),
    localMediaBadges: document.getElementById('localMediaBadges'),
    reactionsLayer: document.getElementById('reactionsLayer'),
    toggleMicBtn: document.getElementById('toggleMicBtn'),
    toggleCamBtn: document.getElementById('toggleCamBtn'),
    toggleScreenBtn: document.getElementById('toggleScreenBtn'),
    toggleRecordBtn: document.getElementById('toggleRecordBtn'),
    toggleHandBtn: document.getElementById('toggleHandBtn'),
    toggleWhiteboardBtn: document.getElementById('toggleWhiteboardBtn'),
    toggle3dBtn: document.getElementById('toggle3dBtn'),
    toggleReactionsBtn: document.getElementById('toggleReactionsBtn'),
    reactionsPicker: document.getElementById('reactionsPicker'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    micSelect: document.getElementById('micSelect'),
    camSelect: document.getElementById('camSelect'),
    toggleChatBtn: document.getElementById('toggleChatBtn'),
    chatUnreadBadge: document.getElementById('chatUnreadBadge'),
    toggleParticipantsBtn: document.getElementById('toggleParticipantsBtn'),
    leaveCallBtn: document.getElementById('leaveCallBtn'),
    sidePanel: document.getElementById('sidePanel'),
    closeSidePanelBtn: document.getElementById('closeSidePanelBtn'),
    tabChat: document.getElementById('tabChat'),
    tabParticipants: document.getElementById('tabParticipants'),
    roomChatList: document.getElementById('roomChatList'),
    roomChatForm: document.getElementById('roomChatForm'),
    roomChatInput: document.getElementById('roomChatInput'),
    roomParticipantsList: document.getElementById('roomParticipantsList')
  };

  // ==========================================================================
  // 1. INITIALISATION
  // ==========================================================================

  async function bootstrap() {
    dom.roomCodeTag.textContent = roomId;
    dom.prejoinRoomCode.textContent = roomId;
    dom.prejoinNameInput.value = userName;
    dom.prejoinAvatarInitials.textContent = getInitials(userName);
    dom.localNameLabel.textContent = `${userName} (Vous)`;
    dom.localAvatarInitials.textContent = getInitials(userName);

    bindUIEvents();
    setupTileInteractions(dom.localTile);
    registerSocketHandlers();

    if (window.MeetWhiteboard) {
      MeetWhiteboard.init({
        socket,
        roomId,
        userName,
        onToggle: (isOpen) => {
          dom.toggleWhiteboardBtn.classList.toggle('active', isOpen);
          if (dom.videoGrid?.parentElement) {
            dom.videoGrid.parentElement.classList.toggle('has-whiteboard', isOpen);
          }
          if (isOpen && window.MeetStudio3D) {
            MeetStudio3D.close({ remote: true });
          }
        }
      });
    }

    initStudio3DModule();

    await Promise.all([loadIceServers(), initLocalMedia()]);
    if (localStream) {
      dom.prejoinVideo.srcObject = localStream;
    }
    updateLocalControlsUI();
  }

  async function loadIceServers() {
    try {
      const res = await fetch('/api/ice-servers');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        rtcConfig = { iceServers: data.iceServers };
      }
    } catch (_err) {
      // Repli silencieux sur RTC_CONFIG
    }
  }

  function enterMeetingFromGreenRoom() {
    if (hasJoinedRoom) return;
    hasJoinedRoom = true;

    const chosenName = dom.prejoinNameInput.value.trim() || userName;
    userName = chosenName;
    MeetCommon.setUserName(userName);

    dom.localNameLabel.textContent = `${userName} (Vous)`;
    dom.localAvatarInitials.textContent = getInitials(userName);
    dom.prejoinVideo.srcObject = null;
    dom.prejoinOverlay.classList.add('hidden');

    if (localStream) {
      dom.localVideo.srcObject = localStream;
      dom.localVideo.play().catch(() => {});
    }

    startCallTimer();
    refreshParticipantsUI();
    joinSignalingRoom();
  }

  /**
   * Démarre le chronomètre de durée d'appel.
   */
  function startCallTimer() {
    const startedAt = Date.now();
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      dom.callTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  // ==========================================================================
  // 2. GESTION MÉDIA LOCALE (getUserMedia)
  // ==========================================================================

  /**
   * Demande l'accès caméra + micro avec fallback progressif :
   * 1) Audio + Vidéo HD
   * 2) Audio seul si la caméra est absente/bloquée
   * 3) Mode réception seule si tout est refusé
   */
  async function initLocalMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMediaAlert('Votre navigateur ne supporte pas WebRTC (HTTPS ou localhost requis).');
      updateLocalControlsUI();
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: {
          width: { ideal: 960, max: 1280 },
          height: { ideal: 540, max: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user'
        }
      });

      audioEnabled = localStream.getAudioTracks().length > 0;
      videoEnabled = localStream.getVideoTracks().length > 0;
      if (hasJoinedRoom) {
        dom.localVideo.srcObject = localStream;
        dom.localVideo.play().catch(() => {});
      }
      if (audioEnabled) startAudioMonitor('local', localStream, dom.localTile);
    } catch (primaryErr) {
      console.warn('Échec accès caméra+micro, tentative audio seul:', primaryErr);

      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioEnabled = localStream.getAudioTracks().length > 0;
        videoEnabled = false;
        if (audioEnabled) startAudioMonitor('local', localStream, dom.localTile);
        showMediaAlert('Caméra indisponible ou refusée. Vous avez rejoint en audio uniquement.');
      } catch (audioErr) {
        console.warn('Échec accès média complet:', audioErr);
        localStream = null;
        audioEnabled = false;
        videoEnabled = false;
        showMediaAlert(formatMediaError(primaryErr));
      }
    }

    updateLocalControlsUI();
  }

  function formatMediaError(err) {
    if (!err || !err.name) {
      return 'Impossible d’accéder à la caméra ou au micro. Mode écoute activé.';
    }
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Permission caméra/micro refusée. Autorisez l’accès dans votre navigateur pour parler ou partager votre vidéo.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Aucune caméra ni microphone détecté. Mode écoute activé.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Votre caméra ou micro est déjà utilisé par une autre application.';
      default:
        return 'Accès média indisponible. Mode écoute activé.';
    }
  }

  function showMediaAlert(message) {
    dom.mediaAlert.textContent = message;
    dom.mediaAlert.classList.remove('hidden');
  }

  // ==========================================================================
  // 3. SIGNALISATION SOCKET.IO
  // ==========================================================================

  function joinSignalingRoom() {
    socket.emit('join-room', {
      roomId,
      name: userName,
      hostToken,
      mediaState: { audio: audioEnabled, video: videoEnabled, screen: screenEnabled }
    });
  }

  function registerSocketHandlers() {
    // Reconnexion automatique après micro-coupure réseau
    socket.io.on('reconnect', () => {
      if (!hasJoinedRoom) return;
      for (const peerId of Array.from(peerConnections.keys())) {
        removePeer(peerId);
      }
      joinSignalingRoom();
      MeetCommon.showToast('Connexion rétablie');
    });

    // Confirmation d'entrée dans la salle : on initie une offre vers chaque pair existant
    socket.on('room-joined', async ({ title, selfIsHost, peers, messages, whiteboardHistory, whiteboardOpen, studio3d }) => {
      dom.roomTitle.textContent = title || 'Réunion';
      if (typeof selfIsHost === 'boolean') {
        isHost = selfIsHost;
      }

      // Restaurer l'historique du chat sans incrémenter le badge non-lu
      (messages || []).forEach((msg) => appendChatMessage(msg, { countUnread: false }));

      // Restaurer l'historique et l'état d'ouverture du tableau blanc
      if (window.MeetWhiteboard) {
        if (Array.isArray(whiteboardHistory)) {
          MeetWhiteboard.loadHistory(whiteboardHistory);
        }
        if (whiteboardOpen) {
          MeetWhiteboard.open({ remote: true });
        }
      }

      // Restaurer l'état du Studio 3D pour les retardataires
      if (studio3d) {
        if (window.MeetStudio3D) {
          MeetStudio3D.loadState(studio3d);
        } else {
          window.__pendingStudio3dState = studio3d;
        }
      }

      for (const peer of peers) {
        peerMetadata.set(peer.socketId, {
          name: peer.name || 'Participant',
          isHost: Boolean(peer.isHost),
          handRaised: Boolean(peer.handRaised),
          mediaState: peer.mediaState || { audio: true, video: true, screen: false }
        });
        ensureRemoteVideoTile(peer.socketId);
        if (peer.mediaState?.screen) {
          pinTile(`tile-${peer.socketId}`, { isAuto: true });
        }
        await initiateOfferToPeer(peer.socketId);
      }

      refreshParticipantsUI();
      updateVideoGridLayout();
    });

    // Un nouveau pair rejoint : on prépare sa tuile + connexion et on attend son offre
    socket.on('user-joined', (peer) => {
      peerMetadata.set(peer.socketId, {
        name: peer.name || 'Participant',
        isHost: Boolean(peer.isHost),
        handRaised: Boolean(peer.handRaised),
        mediaState: peer.mediaState || { audio: true, video: true, screen: false }
      });
      ensureRemoteVideoTile(peer.socketId);
      createPeerConnection(peer.socketId);
      refreshParticipantsUI();
      updateVideoGridLayout();
    });

    socket.on('offer', handleReceiveOffer);
    socket.on('answer', handleReceiveAnswer);
    socket.on('ice-candidate', handleReceiveIceCandidate);

    socket.on('peer-media-state', ({ socketId, mediaState }) => {
      const meta = peerMetadata.get(socketId) || { name: 'Participant', isHost: false };
      const wasSharing = Boolean(meta.mediaState?.screen);
      meta.mediaState = mediaState;
      peerMetadata.set(socketId, meta);

      const tileId = `tile-${socketId}`;
      if (!wasSharing && mediaState?.screen) {
        pinTile(tileId, { isAuto: true });
      } else if (wasSharing && !mediaState?.screen && autoPinnedTileId === tileId) {
        unpinTile();
      }

      updateRemoteTileBadges(socketId, mediaState);
      refreshParticipantsUI();
    });

    socket.on('peer-hand-state', ({ socketId, handRaised: isUp }) => {
      const meta = peerMetadata.get(socketId);
      if (!meta) return;
      meta.handRaised = Boolean(isUp);
      const handEl = document.getElementById(`hand-${socketId}`);
      if (handEl) handEl.classList.toggle('hidden', !meta.handRaised);
      refreshParticipantsUI();
    });

    socket.on('room-reaction', ({ name, emoji }) => {
      spawnFloatingReaction(name, emoji);
    });

    socket.on('force-mute', () => {
      if (localStream && localStream.getAudioTracks().length > 0) {
        audioEnabled = false;
        localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
        syncLocalMediaState();
      }
      MeetCommon.showToast("L'hôte a coupé votre micro");
    });

    socket.on('kicked-from-room', ({ reason }) => {
      cleanupAllConnections();
      alert(reason || "Vous avez été exclu de la réunion par l'hôte.");
      window.location.href = '/';
    });

    socket.on('user-left', ({ socketId }) => {
      removePeer(socketId);
      refreshParticipantsUI();
      updateVideoGridLayout();
    });

    socket.on('room-chat', appendChatMessage);

    socket.on('room-error', ({ message }) => {
      showMediaAlert(message || 'Erreur de connexion à la salle.');
    });
  }

  // ==========================================================================
  // 4. GESTION DES RTCPeerConnection & ÉCHANGES SDP / ICE
  // ==========================================================================

  /**
   * Crée (ou récupère) la RTCPeerConnection pour un pair donné.
   */
  function createPeerConnection(peerId) {
    if (peerConnections.has(peerId)) {
      return peerConnections.get(peerId);
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(peerId, pc);

    // Attacher les pistes locales existantes (audio + vidéo ou écran)
    attachLocalTracksToPeer(pc);

    // Réception des pistes distantes -> stockage dans remoteStreams + affichage
    pc.ontrack = (event) => {
      let stream = event.streams && event.streams[0];
      if (!stream) {
        stream = remoteStreams.get(peerId) || new MediaStream();
        stream.addTrack(event.track);
      }
      remoteStreams.set(peerId, stream);
      renderRemoteVideoTile(peerId, stream);
    };

    // Envoi des candidats ICE découverts vers le pair via Socket.io
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          to: peerId,
          candidate: event.candidate
        });
      }
    };

    // Surveillance de l'état ICE / connexion
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        MeetCommon.showToast('Connexion vidéo bloquée entre réseaux (TURN requis sur 4G/pare-feu).');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeer(peerId);
        refreshParticipantsUI();
        updateVideoGridLayout();
      }
    };

    return pc;
  }

  function attachLocalTracksToPeer(pc) {
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    const activeVideoTrack = screenEnabled && screenStream
      ? screenStream.getVideoTracks()[0]
      : localStream?.getVideoTracks()[0];

    if (activeVideoTrack) {
      const sourceStream = screenEnabled && screenStream ? screenStream : localStream;
      pc.addTrack(activeVideoTrack, sourceStream);
    } else {
      // Prépare un sender vidéo vide pour permettre le partage d'écran ultérieur sans renégociation
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }
  }

  /**
   * Crée et envoie une offre SDP vers un pair.
   */
  async function initiateOfferToPeer(peerId) {
    const pc = createPeerConnection(peerId);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch (err) {
      console.error(`Erreur création offre pour ${peerId}:`, err);
    }
  }

  /**
   * Traite une offre SDP entrante et renvoie une réponse.
   */
  async function handleReceiveOffer({ from, offer }) {
    const pc = createPeerConnection(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIceCandidates(from, pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer: pc.localDescription });
    } catch (err) {
      console.error(`Erreur traitement offre de ${from}:`, err);
    }
  }

  /**
   * Traite une réponse SDP entrante.
   */
  async function handleReceiveAnswer({ from, answer }) {
    const pc = peerConnections.get(from);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIceCandidates(from, pc);
    } catch (err) {
      console.error(`Erreur traitement réponse de ${from}:`, err);
    }
  }

  /**
   * Traite un candidat ICE entrant (ou le met en file si remoteDescription n'est pas encore prête).
   */
  async function handleReceiveIceCandidate({ from, candidate }) {
    if (!candidate) return;

    const pc = peerConnections.get(from);
    if (!pc || !pc.remoteDescription) {
      const queue = pendingIceCandidates.get(from) || [];
      queue.push(candidate);
      pendingIceCandidates.set(from, queue);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn(`Erreur ajout ICE candidate de ${from}:`, err);
    }
  }

  async function flushPendingIceCandidates(peerId, pc) {
    const queue = pendingIceCandidates.get(peerId);
    if (!queue || !queue.length) return;

    pendingIceCandidates.delete(peerId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`Erreur flush ICE candidate pour ${peerId}:`, err);
      }
    }
  }

  /**
   * Ferme proprement la connexion d'un pair et retire sa tuile vidéo.
   */
  function removePeer(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peerConnections.delete(peerId);
    }

    const stream = remoteStreams.get(peerId);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      remoteStreams.delete(peerId);
    }

    peerMetadata.delete(peerId);
    pendingIceCandidates.delete(peerId);
    stopAudioMonitor(peerId);

    const tileId = `tile-${peerId}`;
    if (pinnedTileId === tileId) {
      unpinTile();
    }
    const tile = document.getElementById(tileId);
    if (tile) tile.remove();
  }

  // ==========================================================================
  // 5. AFFICHAGE GRILLE VIDÉO & PARTICIPANTS
  // ==========================================================================

  /**
   * Crée la tuile DOM d'un pair distant si elle n'existe pas encore
   * (permet d'afficher immédiatement l'avatar même si sa caméra est coupée).
   */
  function ensureRemoteVideoTile(peerId) {
    const meta = peerMetadata.get(peerId) || { name: 'Participant', mediaState: {} };
    let tile = document.getElementById(`tile-${peerId}`);

    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `tile-${peerId}`;

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('autoplay', '');
      video.setAttribute('playsinline', '');

      const avatar = document.createElement('div');
      avatar.className = 'avatar-placeholder hidden';
      avatar.id = `avatar-${peerId}`;
      const circle = document.createElement('span');
      circle.className = 'avatar-circle';
      circle.textContent = getInitials(meta.name);
      avatar.appendChild(circle);

      const overlay = document.createElement('div');
      overlay.className = 'video-overlay';

      const label = document.createElement('span');
      label.className = 'participant-label';
      label.textContent = meta.isHost ? `${meta.name} · Hôte` : meta.name;

      const badges = document.createElement('span');
      badges.className = 'media-badges';
      badges.id = `badges-${peerId}`;

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'pin-btn';
      pinBtn.title = 'Épingler / Détacher';
      pinBtn.setAttribute('aria-label', 'Épingler la vidéo');
      pinBtn.textContent = '📌';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinTile(`tile-${peerId}`);
      });

      const handBadge = document.createElement('span');
      handBadge.className = `hand-indicator${meta.handRaised ? '' : ' hidden'}`;
      handBadge.id = `hand-${peerId}`;
      handBadge.title = 'Main levée';
      handBadge.textContent = '✋';

      overlay.appendChild(label);
      overlay.appendChild(badges);
      tile.appendChild(video);
      tile.appendChild(avatar);
      tile.appendChild(handBadge);
      tile.appendChild(pinBtn);
      tile.appendChild(overlay);

      dom.videoGrid.appendChild(tile);
      setupTileInteractions(tile);
      updateVideoGridLayout();
    }

    updateRemoteTileBadges(peerId, meta.mediaState);
    return tile;
  }

  function renderRemoteVideoTile(peerId, stream) {
    const tile = ensureRemoteVideoTile(peerId);
    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    videoEl.play().catch(() => {});
    if (stream.getAudioTracks().length > 0) {
      startAudioMonitor(peerId, stream, tile);
    }
  }

  function updateRemoteTileBadges(peerId, mediaState) {
    const badges = document.getElementById(`badges-${peerId}`);
    const avatar = document.getElementById(`avatar-${peerId}`);
    if (!badges) return;

    const isAudioOff = mediaState && mediaState.audio === false;
    const isVideoOff = mediaState && mediaState.video === false && !mediaState.screen;

    badges.innerHTML = '';
    if (isAudioOff) badges.innerHTML += '<span class="media-badge">Micro coupé</span>';
    if (isVideoOff) badges.innerHTML += '<span class="media-badge">Cam off</span>';

    if (avatar) {
      avatar.classList.toggle('hidden', !isVideoOff);
    }
  }

  function updateVideoGridLayout() {
    const count = dom.videoGrid.querySelectorAll('.video-tile').length;
    dom.videoGrid.setAttribute('data-count', String(count));
    if (count !== 2) {
      dom.videoGrid.classList.remove('is-pip-swapped');
      resetAllTileInlinePositions();
    }
  }

  function resetAllTileInlinePositions() {
    dom.videoGrid.querySelectorAll('.video-tile').forEach((t) => {
      t.style.left = '';
      t.style.top = '';
      t.style.right = '';
      t.style.bottom = '';
    });
  }

  function isFloatingPipTile(tile) {
    const count = dom.videoGrid.querySelectorAll('.video-tile').length;
    const stage = dom.videoGrid.parentElement;
    if (count !== 2 || dom.videoGrid.classList.contains('has-pinned')) return false;
    if (stage && (stage.classList.contains('has-whiteboard') || stage.classList.contains('has-studio3d'))) {
      return false;
    }
    const swapped = dom.videoGrid.classList.contains('is-pip-swapped');
    return swapped ? !tile.classList.contains('is-local') : tile.classList.contains('is-local');
  }

  function setupTileInteractions(tile) {
    if (!tile || tile.dataset.interactive === '1') return;
    tile.dataset.interactive = '1';
    tile.setAttribute('draggable', 'true');

    // 1. Glisser-déposer pour réorganiser les vignettes en grille (>= 3 personnes)
    tile.addEventListener('dragstart', (e) => {
      if (isFloatingPipTile(tile)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', tile.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    tile.addEventListener('dragover', (e) => {
      if (isFloatingPipTile(tile)) return;
      e.preventDefault();
      tile.classList.add('is-drag-over');
    });

    tile.addEventListener('dragleave', () => {
      tile.classList.remove('is-drag-over');
    });

    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('is-drag-over');
      const sourceId = e.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === tile.id) return;
      const sourceTile = document.getElementById(sourceId);
      if (!sourceTile || sourceTile.parentElement !== dom.videoGrid) return;

      // Échanger les deux vignettes dans le DOM
      const placeholder = document.createElement('div');
      dom.videoGrid.insertBefore(placeholder, sourceTile);
      dom.videoGrid.insertBefore(sourceTile, tile);
      dom.videoGrid.insertBefore(tile, placeholder);
      placeholder.remove();
    });

    // 2. Déplacement libre de la vignette PiP (souris + tactile) & clic pour interchanger
    let pointerActive = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    tile.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pin-btn')) return;
      if (!isFloatingPipTile(tile)) return;

      pointerActive = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const gridRect = dom.videoGrid.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      origLeft = tileRect.left - gridRect.left;
      origTop = tileRect.top - gridRect.top;
      tile.setPointerCapture(e.pointerId);
    });

    tile.addEventListener('pointermove', (e) => {
      if (!pointerActive) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 6) return;

      moved = true;
      const gridRect = dom.videoGrid.getBoundingClientRect();
      const maxLeft = Math.max(0, gridRect.width - tile.offsetWidth);
      const maxTop = Math.max(0, gridRect.height - tile.offsetHeight);
      const nextLeft = Math.max(0, Math.min(maxLeft, origLeft + dx));
      const nextTop = Math.max(0, Math.min(maxTop, origTop + dy));

      tile.style.right = 'auto';
      tile.style.bottom = 'auto';
      tile.style.left = `${nextLeft}px`;
      tile.style.top = `${nextTop}px`;
    });

    tile.addEventListener('pointerup', (e) => {
      if (pointerActive) {
        pointerActive = false;
        try { tile.releasePointerCapture(e.pointerId); } catch (_err) {}
        if (!moved) {
          dom.videoGrid.classList.toggle('is-pip-swapped');
          resetAllTileInlinePositions();
        }
      }
    });

    // 3. Clic sur une miniature en mode épinglé -> basculer cette personne en grand format
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn')) return;
      if (dom.videoGrid.classList.contains('has-pinned') && !tile.classList.contains('is-pinned')) {
        pinTile(tile.id, { isAuto: false });
      }
    });
  }

  /**
   * Met à jour la liste des participants dans le panneau latéral avec :
   * mains levées en premier, nom, badge (Vous), badge Hôte, état micro/caméra et actions hôte.
   */
  function refreshParticipantsUI() {
    const total = peerMetadata.size + 1;
    dom.peerCountBadge.textContent = String(total);
    dom.roomParticipantsList.innerHTML = '';

    const allEntries = [
      {
        socketId: 'self',
        name: userName,
        isSelf: true,
        isHost,
        handRaised,
        audio: audioEnabled,
        video: videoEnabled || screenEnabled
      }
    ];

    for (const [socketId, meta] of peerMetadata.entries()) {
      allEntries.push({
        socketId,
        name: meta.name,
        isSelf: false,
        isHost: Boolean(meta.isHost),
        handRaised: Boolean(meta.handRaised),
        audio: meta.mediaState?.audio !== false,
        video: meta.mediaState?.video !== false || Boolean(meta.mediaState?.screen)
      });
    }

    // Remonter les participants ayant levé la main en premier
    allEntries.sort((a, b) => Number(b.handRaised) - Number(a.handRaised));

    allEntries.forEach((entry) => {
      dom.roomParticipantsList.appendChild(createParticipantListItem(entry));
    });
  }

  function createParticipantListItem({ socketId, name, isSelf, isHost: hostFlag, handRaised: isHandUp, audio, video }) {
    const li = document.createElement('li');
    li.className = 'participant-row';

    const left = document.createElement('div');
    left.className = 'participant-meta';

    if (isHandUp) {
      const handSpan = document.createElement('span');
      handSpan.title = 'Main levée';
      handSpan.textContent = '✋';
      left.appendChild(handSpan);
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = isSelf ? `${name} (Vous)` : name;
    left.appendChild(nameSpan);

    if (hostFlag) {
      const hostBadge = document.createElement('span');
      hostBadge.className = 'role-badge';
      hostBadge.textContent = 'Hôte';
      left.appendChild(hostBadge);
    }

    const right = document.createElement('div');
    right.className = 'participant-media-icons';

    const micIcon = document.createElement('span');
    micIcon.title = audio ? 'Micro actif' : 'Micro coupé';
    micIcon.textContent = audio ? '🎙️' : '🔇';
    if (!audio) micIcon.className = 'media-dot-off';

    const camIcon = document.createElement('span');
    camIcon.title = video ? 'Caméra active' : 'Caméra coupée';
    camIcon.textContent = video ? '📹' : '🚫';
    if (!video) camIcon.className = 'media-dot-off';

    right.appendChild(micIcon);
    right.appendChild(camIcon);

    // Contrôles Hôte pour couper le micro ou exclure un participant
    if (isHost && !isSelf) {
      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'host-action-btn';
      muteBtn.title = 'Couper le micro de ce participant';
      muteBtn.textContent = '🔇';
      muteBtn.addEventListener('click', () => {
        socket.emit('host-mute-peer', { roomId, targetSocketId: socketId, hostToken });
      });

      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'host-action-btn host-kick-btn';
      kickBtn.title = 'Exclure ce participant';
      kickBtn.textContent = '🚫';
      kickBtn.addEventListener('click', () => {
        socket.emit('host-kick-peer', { roomId, targetSocketId: socketId, hostToken });
      });

      right.appendChild(muteBtn);
      right.appendChild(kickBtn);
    }

    li.appendChild(left);
    li.appendChild(right);
    return li;
  }

  // ==========================================================================
  // 6. CONTRÔLES UTILISATEUR (MICRO, CAMÉRA, ÉCRAN, CHAT, QUITTER)
  // ==========================================================================

  function bindUIEvents() {
    dom.toggleMicBtn.addEventListener('click', toggleMicrophone);
    dom.toggleCamBtn.addEventListener('click', toggleCamera);
    dom.prejoinMicBtn.addEventListener('click', toggleMicrophone);
    dom.prejoinCamBtn.addEventListener('click', toggleCamera);
    dom.joinNowBtn.addEventListener('click', enterMeetingFromGreenRoom);
    dom.prejoinNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') enterMeetingFromGreenRoom();
    });

    dom.toggleScreenBtn.addEventListener('click', toggleScreenShare);
    dom.toggleRecordBtn.addEventListener('click', toggleRecording);
    dom.toggleHandBtn.addEventListener('click', toggleHandRaise);
    dom.toggleWhiteboardBtn.addEventListener('click', () => {
      if (window.MeetWhiteboard) MeetWhiteboard.toggle();
    });
    dom.toggle3dBtn.addEventListener('click', () => {
      if (window.MeetStudio3D) MeetStudio3D.toggle();
    });
    dom.toggleReactionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dom.reactionsPicker.classList.toggle('hidden');
    });
    document.querySelectorAll('.reaction-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        socket.emit('room-reaction', { roomId, name: userName, emoji });
        dom.reactionsPicker.classList.add('hidden');
      });
    });
    document.addEventListener('click', (e) => {
      if (!dom.reactionsPicker.contains(e.target) && e.target !== dom.toggleReactionsBtn) {
        dom.reactionsPicker.classList.add('hidden');
      }
    });

    dom.openSettingsBtn.addEventListener('click', openSettingsModal);
    dom.closeSettingsBtn.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) dom.settingsModal.classList.add('hidden');
    });
    dom.micSelect.addEventListener('change', (e) => switchAudioDevice(e.target.value));
    dom.camSelect.addEventListener('change', (e) => switchVideoDevice(e.target.value));

    dom.leaveCallBtn.addEventListener('click', leaveMeeting);
    dom.localPinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePinTile('localTile');
    });

    dom.toggleChatBtn.addEventListener('click', () => toggleSidePanel('chat'));
    dom.toggleParticipantsBtn.addEventListener('click', () => toggleSidePanel('participants'));
    dom.closeSidePanelBtn.addEventListener('click', () => dom.sidePanel.classList.add('hidden'));

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => openSideTab(btn.dataset.tab));
    });

    dom.roomChatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = dom.roomChatInput.value.trim();
      if (!message) return;
      socket.emit('room-chat', { roomId, name: userName, message });
      dom.roomChatInput.value = '';
    });

    dom.copyRoomLinkBtn.addEventListener('click', openInviteModal);
    dom.closeInviteBtn.addEventListener('click', () => dom.inviteModal.classList.add('hidden'));
    dom.inviteModal.addEventListener('click', (e) => {
      if (e.target === dom.inviteModal) dom.inviteModal.classList.add('hidden');
    });
    dom.copyWaitInviteBtn.addEventListener('click', async () => {
      await MeetCommon.copyToClipboard(dom.inviteWaitInput.value);
      MeetCommon.showToast('Lien de la salle d’attente copié');
      dom.inviteModal.classList.add('hidden');
    });
    dom.copyDirectInviteBtn.addEventListener('click', async () => {
      await MeetCommon.copyToClipboard(dom.inviteDirectInput.value);
      MeetCommon.showToast('Lien direct de la réunion copié');
      dom.inviteModal.classList.add('hidden');
    });

    window.addEventListener('beforeunload', cleanupAllConnections);
  }

  function toggleMicrophone() {
    if (!localStream || localStream.getAudioTracks().length === 0) {
      MeetCommon.showToast('Aucun microphone disponible.');
      return;
    }
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = audioEnabled;
    });
    syncLocalMediaState();
  }

  function toggleCamera() {
    if (!localStream || localStream.getVideoTracks().length === 0) {
      MeetCommon.showToast('Aucune caméra disponible.');
      return;
    }
    videoEnabled = !videoEnabled;
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = videoEnabled;
    });
    syncLocalMediaState();
  }

  async function toggleScreenShare() {
    if (screenEnabled) {
      stopScreenShare();
      return;
    }

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      replaceVideoTrackAcrossPeers(screenTrack);
      dom.localVideo.srcObject = screenStream;
      dom.localTile.classList.add('is-screen');
      screenEnabled = true;
      pinTile('localTile', { isAuto: true });

      // Retour automatique à la caméra quand l'utilisateur arrête via la barre native du navigateur
      screenTrack.onended = stopScreenShare;
      syncLocalMediaState();
    } catch (err) {
      MeetCommon.showToast('Partage d’écran annulé.');
    }
  }

  function stopScreenShare() {
    if (!screenEnabled) return;

    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }

    const camTrack = localStream?.getVideoTracks()[0] || null;
    replaceVideoTrackAcrossPeers(camTrack);

    dom.localVideo.srcObject = localStream;
    dom.localTile.classList.remove('is-screen');
    screenEnabled = false;
    if (autoPinnedTileId === 'localTile') {
      unpinTile();
    }
    syncLocalMediaState();
  }

  function replaceVideoTrackAcrossPeers(newTrack) {
    for (const pc of peerConnections.values()) {
      const videoSender = pc.getSenders().find(
        (s) => (s.track && s.track.kind === 'video') || (!s.track && s.dtmf === null)
      );
      if (videoSender) {
        videoSender.replaceTrack(newTrack);
      }
    }
  }

  function syncLocalMediaState() {
    updateLocalControlsUI();
    refreshParticipantsUI();
    socket.emit('media-state-change', {
      roomId,
      audio: audioEnabled,
      video: videoEnabled,
      screen: screenEnabled
    });
  }

  function updateLocalControlsUI() {
    dom.toggleMicBtn.classList.toggle('is-off', !audioEnabled);
    dom.toggleCamBtn.classList.toggle('is-off', !videoEnabled);
    dom.prejoinMicBtn.classList.toggle('is-off', !audioEnabled);
    dom.prejoinCamBtn.classList.toggle('is-off', !videoEnabled);
    dom.toggleScreenBtn.classList.toggle('active', screenEnabled);

    const showLocalAvatar = !videoEnabled && !screenEnabled;
    dom.localAvatar.classList.toggle('hidden', !showLocalAvatar);
    dom.prejoinAvatar.classList.toggle('hidden', videoEnabled);

    dom.localMediaBadges.innerHTML = '';
    if (!audioEnabled) dom.localMediaBadges.innerHTML += '<span class="media-badge">Micro coupé</span>';
    if (showLocalAvatar) dom.localMediaBadges.innerHTML += '<span class="media-badge">Cam off</span>';
  }

  function leaveMeeting() {
    socket.emit('leave-room');
    cleanupAllConnections();
    window.location.href = '/';
  }

  function cleanupAllConnections() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    stopAudioMonitor('local');
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    for (const peerId of Array.from(peerConnections.keys())) {
      removePeer(peerId);
    }
  }

  // ==========================================================================
  // 7. ACTIVE SPEAKER (WEB AUDIO API) & ÉPINGLAGE (SPOTLIGHT)
  // ==========================================================================

  function getSharedAudioContext() {
    if (!sharedAudioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) sharedAudioContext = new AudioCtx();
    }
    if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
  }

  function startAudioMonitor(id, stream, tileEl) {
    if (audioMonitors.has(id) || !tileEl || !stream || stream.getAudioTracks().length === 0) {
      return;
    }
    const ctx = getSharedAudioContext();
    if (!ctx) return;

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const intervalId = setInterval(() => {
        const isMuted = id === 'local'
          ? !audioEnabled
          : peerMetadata.get(id)?.mediaState?.audio === false;

        if (isMuted) {
          tileEl.classList.remove('is-speaking');
          if (id === 'local' && dom.prejoinMicBar) dom.prejoinMicBar.style.width = '0%';
          return;
        }

        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i];
        const avg = sum / data.length;

        if (id === 'local' && dom.prejoinMicBar) {
          dom.prejoinMicBar.style.width = `${Math.min(100, Math.round(avg * 2.2))}%`;
        }
        tileEl.classList.toggle('is-speaking', avg > 16);
      }, 120);

      audioMonitors.set(id, { intervalId, source });
    } catch (err) {
      console.warn('Impossible de démarrer le moniteur audio:', err);
    }
  }

  function stopAudioMonitor(id) {
    const monitor = audioMonitors.get(id);
    if (!monitor) return;
    clearInterval(monitor.intervalId);
    try {
      monitor.source.disconnect();
    } catch (_e) {}
    audioMonitors.delete(id);
  }

  function togglePinTile(tileId) {
    if (pinnedTileId === tileId) {
      unpinTile();
    } else {
      pinTile(tileId, { isAuto: false });
    }
  }

  function pinTile(tileId, { isAuto = false } = {}) {
    const targetTile = document.getElementById(tileId);
    if (!targetTile) return;

    if (pinnedTileId && pinnedTileId !== tileId) {
      const prev = document.getElementById(pinnedTileId);
      if (prev) prev.classList.remove('is-pinned');
    }

    pinnedTileId = tileId;
    autoPinnedTileId = isAuto ? tileId : null;
    targetTile.classList.add('is-pinned');
    dom.videoGrid.classList.add('has-pinned');
  }

  function unpinTile() {
    if (pinnedTileId) {
      const prev = document.getElementById(pinnedTileId);
      if (prev) prev.classList.remove('is-pinned');
    }
    pinnedTileId = null;
    autoPinnedTileId = null;
    dom.videoGrid.classList.remove('has-pinned');
  }

  // ==========================================================================
  // 7. PANNEAU LATÉRAL & UTILITAIRES
  // ==========================================================================

  function isChatTabVisible() {
    return !dom.sidePanel.classList.contains('hidden') && !dom.tabChat.classList.contains('hidden');
  }

  function resetUnreadChatBadge() {
    unreadChatCount = 0;
    dom.chatUnreadBadge.textContent = '0';
    dom.chatUnreadBadge.classList.add('hidden');
  }

  function toggleSidePanel(tabName) {
    const isHidden = dom.sidePanel.classList.contains('hidden');
    const isSameTab = tabName === 'chat'
      ? !dom.tabChat.classList.contains('hidden')
      : !dom.tabParticipants.classList.contains('hidden');

    if (!isHidden && isSameTab) {
      dom.sidePanel.classList.add('hidden');
    } else {
      openSideTab(tabName);
    }
  }

  function openSideTab(tabName) {
    dom.sidePanel.classList.remove('hidden');
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    dom.tabChat.classList.toggle('hidden', tabName !== 'chat');
    dom.tabParticipants.classList.toggle('hidden', tabName !== 'participants');

    if (tabName === 'chat') {
      resetUnreadChatBadge();
    }
  }

  function appendChatMessage(msg, { countUnread = true } = {}) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = `${msg.name} · ${new Date(msg.time).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })}`;

    const body = document.createElement('div');
    body.textContent = msg.message;

    li.appendChild(meta);
    li.appendChild(body);
    dom.roomChatList.appendChild(li);
    dom.roomChatList.scrollTop = dom.roomChatList.scrollHeight;

    if (countUnread && !isChatTabVisible()) {
      unreadChatCount += 1;
      dom.chatUnreadBadge.textContent = String(unreadChatCount);
      dom.chatUnreadBadge.classList.remove('hidden');
    }
  }

  function getInitials(name) {
    return (name || 'P')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'P';
  }

  function toggleHandRaise() {
    handRaised = !handRaised;
    dom.toggleHandBtn.classList.toggle('is-hand-up', handRaised);
    dom.localHandBadge.classList.toggle('hidden', !handRaised);
    socket.emit('hand-state-change', { roomId, handRaised });
    refreshParticipantsUI();
  }

  function spawnFloatingReaction(name, emoji) {
    const wrapper = document.createElement('div');
    wrapper.className = 'floating-reaction';
    wrapper.style.left = `${15 + Math.random() * 70}%`;

    const emojiEl = document.createElement('span');
    emojiEl.className = 'floating-reaction-emoji';
    emojiEl.textContent = emoji;

    const nameEl = document.createElement('span');
    nameEl.className = 'floating-reaction-name';
    nameEl.textContent = name;

    wrapper.appendChild(emojiEl);
    wrapper.appendChild(nameEl);
    dom.reactionsLayer.appendChild(wrapper);

    wrapper.addEventListener('animationend', () => wrapper.remove());
  }

  // ==========================================================================
  // 8. SÉLECTEUR DE CAMÉRA ET MICROPHONE
  // ==========================================================================

  async function openSettingsModal() {
    dom.settingsModal.classList.remove('hidden');
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const activeAudioId = localStream?.getAudioTracks()[0]?.getSettings()?.deviceId || '';
      const activeVideoId = localStream?.getVideoTracks()[0]?.getSettings()?.deviceId || '';

      dom.micSelect.innerHTML = '';
      dom.camSelect.innerHTML = '';

      devices
        .filter((d) => d.kind === 'audioinput')
        .forEach((d, idx) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${idx + 1}`;
          if (d.deviceId === activeAudioId) opt.selected = true;
          dom.micSelect.appendChild(opt);
        });

      devices
        .filter((d) => d.kind === 'videoinput')
        .forEach((d, idx) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Caméra ${idx + 1}`;
          if (d.deviceId === activeVideoId) opt.selected = true;
          dom.camSelect.appendChild(opt);
        });
    } catch (err) {
      MeetCommon.showToast('Impossible de lister les périphériques.');
    }
  }

  async function switchAudioDevice(deviceId) {
    if (!deviceId) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      });
      const newTrack = newStream.getAudioTracks()[0];
      newTrack.enabled = audioEnabled;

      if (!localStream) localStream = new MediaStream();
      localStream.getAudioTracks().forEach((oldTrack) => {
        localStream.removeTrack(oldTrack);
        oldTrack.stop();
      });
      localStream.addTrack(newTrack);

      for (const pc of peerConnections.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(newTrack);
      }

      stopAudioMonitor('local');
      startAudioMonitor('local', localStream, dom.localTile);
      MeetCommon.showToast('Microphone mis à jour');
    } catch (err) {
      MeetCommon.showToast('Erreur lors du changement de microphone.');
    }
  }

  async function switchVideoDevice(deviceId) {
    if (!deviceId) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const newTrack = newStream.getVideoTracks()[0];
      newTrack.enabled = videoEnabled;

      if (!localStream) localStream = new MediaStream();
      localStream.getVideoTracks().forEach((oldTrack) => {
        localStream.removeTrack(oldTrack);
        oldTrack.stop();
      });
      localStream.addTrack(newTrack);

      if (!screenEnabled) {
        dom.localVideo.srcObject = localStream;
        if (!hasJoinedRoom) dom.prejoinVideo.srcObject = localStream;
        replaceVideoTrackAcrossPeers(newTrack);
      }
      MeetCommon.showToast('Caméra mise à jour');
    } catch (err) {
      MeetCommon.showToast('Erreur lors du changement de caméra.');
    }
  }

  // ==========================================================================
  // 9. MODALE INVITER & ENREGISTREMENT LOCAL (MediaRecorder)
  // ==========================================================================

  function openInviteModal() {
    dom.inviteWaitInput.value = `${window.location.origin}/wait/${roomId}`;
    dom.inviteDirectInput.value = `${window.location.origin}/room/${roomId}`;
    dom.inviteModal.classList.remove('hidden');
  }

  async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }

    try {
      recordDisplayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: true
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      recordAudioCtx = new AudioCtx();
      const dest = recordAudioCtx.createMediaStreamDestination();

      if (recordDisplayStream.getAudioTracks().length > 0) {
        recordAudioCtx.createMediaStreamSource(recordDisplayStream).connect(dest);
      }
      if (localStream && localStream.getAudioTracks().length > 0) {
        recordAudioCtx.createMediaStreamSource(localStream).connect(dest);
      }

      const combinedTracks = [
        ...recordDisplayStream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ];
      const combinedStream = new MediaStream(combinedTracks);

      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ].find((t) => MediaRecorder.isTypeSupported(t)) || '';

      recordedChunks = [];
      mediaRecorder = mimeType
        ? new MediaRecorder(combinedStream, { mimeType })
        : new MediaRecorder(combinedStream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = finalizeRecording;

      recordDisplayStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      };

      mediaRecorder.start(1000);
      startRecUI();
      MeetCommon.showToast('Enregistrement démarré');
    } catch (err) {
      MeetCommon.showToast('Enregistrement annulé ou non supporté.');
      stopRecCleanup();
    }
  }

  function startRecUI() {
    const recStartedAt = Date.now();
    dom.recIndicator.classList.remove('hidden');
    dom.toggleRecordBtn.classList.add('is-recording');
    dom.recTimer.textContent = 'REC 00:00';

    recordTimerId = setInterval(() => {
      const secs = Math.floor((Date.now() - recStartedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      dom.recTimer.textContent = `REC ${mm}:${ss}`;
    }, 1000);
  }

  function finalizeRecording() {
    if (recordedChunks.length > 0) {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = `meetlite-enregistrement-${dateStr}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      MeetCommon.showToast('Enregistrement téléchargé');
    }
    stopRecCleanup();
  }

  function stopRecCleanup() {
    if (recordTimerId) {
      clearInterval(recordTimerId);
      recordTimerId = null;
    }
    if (recordDisplayStream) {
      recordDisplayStream.getTracks().forEach((t) => t.stop());
      recordDisplayStream = null;
    }
    if (recordAudioCtx) {
      recordAudioCtx.close().catch(() => {});
      recordAudioCtx = null;
    }
    dom.recIndicator.classList.add('hidden');
    dom.toggleRecordBtn.classList.remove('is-recording');
    mediaRecorder = null;
    recordedChunks = [];
  }

  function initStudio3DModule() {
    const setup = () => {
      if (!window.MeetStudio3D) return;
      MeetStudio3D.init({
        socket,
        roomId,
        userName,
        isHost,
        onToggle: (isOpen) => {
          dom.toggle3dBtn.classList.toggle('active', isOpen);
          if (dom.videoGrid?.parentElement) {
            dom.videoGrid.parentElement.classList.toggle('has-studio3d', isOpen);
          }
          if (isOpen && window.MeetWhiteboard) {
            MeetWhiteboard.close({ remote: true });
          }
        }
      });
      if (window.__pendingStudio3dState) {
        MeetStudio3D.loadState(window.__pendingStudio3dState);
        delete window.__pendingStudio3dState;
      }
    };

    if (window.MeetStudio3D) setup();
    else window.addEventListener('meet-studio3d-ready', setup, { once: true });
  }

  // Lancement
  bootstrap();
})();
