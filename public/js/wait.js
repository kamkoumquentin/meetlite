/**
 * wait.js — Logique client de la salle d'attente musicale (Socket.io)
 */

(function () {
  const roomId = MeetCommon.getRoomIdFromPath();
  const hostToken = MeetCommon.getHostToken(roomId);
  let isHost = Boolean(hostToken) || MeetCommon.isHostFromQuery();
  const userName = MeetCommon.ensureUserName(isHost ? 'Hôte' : 'Participant');

  const socket = io({
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000
  });

  // Éléments DOM
  const roomCodeTag = document.getElementById('roomCodeTag');
  const roomTitle = document.getElementById('roomTitle');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const hostControls = document.getElementById('hostControls');
  const startMeetingBtn = document.getElementById('startMeetingBtn');
  const joinSection = document.getElementById('joinSection');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const participantsList = document.getElementById('participantsList');
  const waitCount = document.getElementById('waitCount');
  const waitMessagesList = document.getElementById('waitMessagesList');
  const messageInput = document.getElementById('messageInput');
  const sendMsgBtn = document.getElementById('sendMsgBtn');
  const copyWaitLinkBtn = document.getElementById('copyWaitLinkBtn');

  // Lecteur d'ambiance Web Audio API (100% autonome hors-ligne)
  const playBtn = document.getElementById('playBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const equalizer = document.getElementById('equalizer');

  const ambientPlayer = createAmbientPlayer();
  let isPlaying = false;

  function createAmbientPlayer() {
    let ctx = null;
    let masterGain = null;
    let loopTimer = null;
    let chordIndex = 0;

    // Progression d'accords doux (Cmaj7 -> Am7 -> Fmaj7 -> G6)
    const chords = [
      [261.63, 329.63, 392.0, 493.88],
      [220.0, 261.63, 329.63, 392.0],
      [174.61, 220.0, 261.63, 329.63],
      [196.0, 246.94, 293.66, 329.63]
    ];

    function ensureContext() {
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioCtx();
        masterGain = ctx.createGain();
        masterGain.gain.value = Number(volumeSlider.value) * 0.25;
        masterGain.connect(ctx.destination);
      }
      return ctx;
    }

    function playChord(freqs) {
      if (!ctx || !masterGain) return;
      const now = ctx.currentTime;
      const duration = 4.2;

      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const env = ctx.createGain();

        osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(900, now);

        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(0.18 / freqs.length, now + 1.0);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        osc.connect(filter);
        filter.connect(env);
        env.connect(masterGain);

        osc.start(now);
        osc.stop(now + duration + 0.05);
      });
    }

    async function start() {
      const audioCtx = ensureContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      if (loopTimer) return;

      playChord(chords[chordIndex % chords.length]);
      chordIndex += 1;
      loopTimer = setInterval(() => {
        playChord(chords[chordIndex % chords.length]);
        chordIndex += 1;
      }, 3600);
    }

    function stop() {
      if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
      if (ctx && ctx.state === 'running') {
        ctx.suspend();
      }
    }

    function setVolume(val) {
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(Number(val) * 0.25, ctx.currentTime, 0.05);
      }
    }

    return { start, stop, setVolume };
  }

  roomCodeTag.textContent = roomId;

  if (isHost) {
    hostControls.classList.remove('hidden');
  }

  // Rejoindre le canal de salle d'attente
  socket.emit('join-wait', { roomId, name: userName, hostToken });

  // État initial de la salle
  socket.on('wait-state', (room) => {
    roomTitle.textContent = room.title || 'Réunion';
    if (typeof room.selfIsHost === 'boolean') {
      isHost = room.selfIsHost;
      hostControls.classList.toggle('hidden', !isHost);
    }
    renderParticipants(room.waitingParticipants || []);
    (room.messages || []).forEach(appendMessage);

    // Si la réunion a déjà démarré, rediriger immédiatement vers la salle vidéo
    if (room.status === 'started') {
      onMeetingStarted({ redirectUrl: `/room/${roomId}`, immediate: true });
    }
  });

  // Mise à jour de la liste des participants en attente
  socket.on('wait-participants', renderParticipants);

  // Nouveau message dans la salle d'attente
  socket.on('wait-message', appendMessage);

  // L'hôte a lancé la réunion : transition vers la salle vidéo
  socket.on('meeting-started', onMeetingStarted);

  socket.on('room-error', ({ message }) => {
    MeetCommon.showToast(message || 'Salle introuvable');
    statusText.textContent = message || 'Salle introuvable.';
  });

  // Bouton hôte : déclencher "start-meeting"
  startMeetingBtn.addEventListener('click', () => {
    socket.emit('start-meeting', { roomId, hostToken });
  });

  // Copier le lien d'attente (sans ?host=1)
  copyWaitLinkBtn.addEventListener('click', async () => {
    const shareUrl = `${window.location.origin}/wait/${roomId}`;
    await MeetCommon.copyToClipboard(shareUrl);
    MeetCommon.showToast('Lien de la salle d\'attente copié');
  });

  // Envoi de message rapide
  function sendWaitMessage() {
    const msg = messageInput.value.trim();
    if (!msg) return;
    socket.emit('wait-message', { roomId, name: userName, message: msg });
    messageInput.value = '';
  }

  sendMsgBtn.addEventListener('click', sendWaitMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendWaitMessage();
  });

  // Contrôles du lecteur musical
  function setPlayingUI(playing) {
    isPlaying = playing;
    playBtn.textContent = playing ? '❚❚' : '▶';
    equalizer.classList.toggle('playing', playing);
  }

  playBtn.addEventListener('click', () => {
    if (isPlaying) {
      ambientPlayer.stop();
      setPlayingUI(false);
    } else {
      ambientPlayer.start().then(() => setPlayingUI(true)).catch(() => {
        MeetCommon.showToast('Cliquez à nouveau pour autoriser l\'audio.');
      });
    }
  });

  volumeSlider.addEventListener('input', (e) => {
    ambientPlayer.setVolume(e.target.value);
  });

  // Tentative de démarrage automatique (si autorisée par le navigateur)
  ambientPlayer.start().then(() => setPlayingUI(true)).catch(() => {});

  function onMeetingStarted({ redirectUrl, immediate = false }) {
    const params = new URLSearchParams();
    if (isHost) params.set('host', '1');
    params.set('name', userName);
    const targetUrl = `${redirectUrl}?${params.toString()}`;

    if (immediate) {
      window.location.replace(targetUrl);
      return;
    }

    statusBadge.textContent = 'Réunion ouverte';
    statusBadge.classList.add('status-ready');
    statusText.textContent = 'Connexion à la salle vidéo en cours...';
    joinRoomBtn.href = targetUrl;
    joinSection.classList.remove('hidden');

    // Redirection automatique après une courte pause pour laisser l'utilisateur voir le statut
    setTimeout(() => {
      window.location.href = targetUrl;
    }, 600);
  }

  function renderParticipants(list) {
    waitCount.textContent = String(list.length);
    participantsList.innerHTML = '';

    if (!list.length) {
      participantsList.innerHTML = '<li style="color: var(--text-muted)">Aucun participant</li>';
      return;
    }

    list.forEach((p) => {
      const li = document.createElement('li');
      const roleTag = p.isHost ? ' · Hôte' : '';
      const selfTag = p.socketId === socket.id ? ' (vous)' : '';
      li.textContent = `${p.name}${roleTag}${selfTag}`;
      participantsList.appendChild(li);
    });
  }

  function appendMessage(msg) {
    const li = document.createElement('li');
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = `${msg.name}:`;

    const text = document.createTextNode(msg.message);
    li.appendChild(author);
    li.appendChild(text);
    waitMessagesList.appendChild(li);
    waitMessagesList.scrollTop = waitMessagesList.scrollHeight;
  }
})();
