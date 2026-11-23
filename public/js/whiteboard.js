/**
 * whiteboard.js — Tableau blanc collaboratif HTML5 Canvas + Socket.io
 *
 * Fonctionnalités :
 *  - Outils : stylo, ligne, rectangle, cercle, texte, gomme
 *  - Coordonnées normalisées (0..1) pour un rendu identique PC / mobile
 *  - Aperçu temps réel des formes sur canvas de prévisualisation
 *  - Redimensionnement automatique avec replay de l'historique
 *  - Support souris et tactile + bascule thème sombre/clair + export PNG
 */

window.MeetWhiteboard = (function () {
  'use strict';

  let socketRef = null;
  let roomIdRef = '';
  let userNameRef = '';
  let onToggleCallback = null;

  let isOpen = false;
  let isDarkTheme = true;
  let activeTool = 'pen';
  let activeColor = '#ffffff';
  let activeSize = 5;

  let isDrawing = false;
  let startPos = { x: 0, y: 0 };
  let lastPos = { x: 0, y: 0 };
  let pendingTextNorm = null;

  // Historique local pour replay lors du redimensionnement
  let localHistory = [];

  // Éléments DOM
  const dom = {};
  let mainCtx = null;
  let previewCtx = null;

  function init({ socket, roomId, userName, onToggle }) {
    socketRef = socket;
    roomIdRef = roomId;
    userNameRef = userName;
    onToggleCallback = onToggle;

    dom.container = document.getElementById('whiteboardContainer');
    dom.canvasWrap = document.getElementById('wbCanvasWrap');
    dom.canvas = document.getElementById('whiteboardCanvas');
    dom.previewCanvas = document.getElementById('whiteboardPreviewCanvas');
    dom.textInput = document.getElementById('wbTextInput');
    dom.themeBtn = document.getElementById('wbThemeBtn');
    dom.clearBtn = document.getElementById('wbClearBtn');
    dom.exportBtn = document.getElementById('wbExportBtn');
    dom.closeBtn = document.getElementById('wbCloseBtn');

    if (!dom.canvas || !dom.previewCanvas) return;

    mainCtx = dom.canvas.getContext('2d');
    previewCtx = dom.previewCanvas.getContext('2d');

    bindToolbarEvents();
    bindCanvasEvents();
    bindResizeObserver();
    registerSocketEvents();
  }

  // ==========================================================================
  // OUVERTURE / FERMETURE & HISTORIQUE
  // ==========================================================================

  function open() {
    if (isOpen) return;
    isOpen = true;
    dom.container.classList.remove('hidden');
    resizeCanvases();
    emitToggle(true);
    if (onToggleCallback) onToggleCallback(true);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hideTextInput();
    dom.container.classList.add('hidden');
    emitToggle(false);
    if (onToggleCallback) onToggleCallback(false);
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function emitToggle(openState) {
    if (!socketRef) return;
    socketRef.emit('wb-toggle', {
      roomId: roomIdRef,
      name: userNameRef,
      isOpen: openState
    });
  }

  function loadHistory(actions) {
    localHistory = Array.isArray(actions) ? actions.slice() : [];
    replayHistory();
  }

  // ==========================================================================
  // ÉVÉNEMENTS BARRE D'OUTILS
  // ==========================================================================

  function bindToolbarEvents() {
    document.querySelectorAll('.wb-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTool = btn.dataset.tool;
        document.querySelectorAll('.wb-tool-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        hideTextInput();
      });
    });

    document.querySelectorAll('.wb-color-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeColor = btn.dataset.color;
        document.querySelectorAll('.wb-color-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.querySelectorAll('.wb-size-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSize = Number(btn.dataset.size) || 5;
        document.querySelectorAll('.wb-size-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    dom.themeBtn.addEventListener('click', () => {
      isDarkTheme = !isDarkTheme;
      dom.canvasWrap.classList.toggle('wb-theme-dark', isDarkTheme);
      dom.canvasWrap.classList.toggle('wb-theme-light', !isDarkTheme);
    });

    dom.clearBtn.addEventListener('click', () => {
      if (!socketRef) return;
      socketRef.emit('wb-clear', { roomId: roomIdRef });
    });

    dom.exportBtn.addEventListener('click', exportAsPNG);
    dom.closeBtn.addEventListener('click', close);

    dom.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTextInput();
      } else if (e.key === 'Escape') {
        hideTextInput();
      }
    });
  }

  // ==========================================================================
  // ÉVÉNEMENTS SOURIS & TACTILE + REDIMENSIONNEMENT
  // ==========================================================================

  function bindResizeObserver() {
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (isOpen) resizeCanvases();
      });
      observer.observe(dom.canvasWrap);
    } else {
      window.addEventListener('resize', () => {
        if (isOpen) resizeCanvases();
      });
    }
  }

  function resizeCanvases() {
    const width = dom.canvasWrap.clientWidth;
    const height = dom.canvasWrap.clientHeight;
    if (!width || !height) return;

    dom.canvas.width = width;
    dom.canvas.height = height;
    dom.previewCanvas.width = width;
    dom.previewCanvas.height = height;

    replayHistory();
  }

  function getRelativePos(clientX, clientY) {
    const rect = dom.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, clientY - rect.top))
    };
  }

  function normalizePos(pos) {
    const w = dom.canvas.width || 1;
    const h = dom.canvas.height || 1;
    return { x: pos.x / w, y: pos.y / h };
  }

  function bindCanvasEvents() {
    // Souris
    dom.canvas.addEventListener('mousedown', (e) => {
      handlePointerStart(getRelativePos(e.clientX, e.clientY));
    });
    dom.canvas.addEventListener('mousemove', (e) => {
      handlePointerMove(getRelativePos(e.clientX, e.clientY));
    });
    dom.canvas.addEventListener('mouseup', (e) => {
      handlePointerEnd(getRelativePos(e.clientX, e.clientY));
    });
    dom.canvas.addEventListener('mouseleave', () => {
      if (isDrawing) handlePointerEnd(lastPos);
    });

    // Tactile mobile / tablette
    dom.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      if (touch) handlePointerStart(getRelativePos(touch.clientX, touch.clientY));
    }, { passive: false });

    dom.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      if (touch) handlePointerMove(getRelativePos(touch.clientX, touch.clientY));
    }, { passive: false });

    dom.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      handlePointerEnd(touch ? getRelativePos(touch.clientX, touch.clientY) : lastPos);
    }, { passive: false });
  }

  function handlePointerStart(pos) {
    if (activeTool === 'text') {
      showTextInputAt(pos);
      return;
    }

    isDrawing = true;
    startPos = pos;
    lastPos = pos;
  }

  function handlePointerMove(pos) {
    if (!isDrawing) return;

    if (activeTool === 'pen' || activeTool === 'eraser') {
      const n0 = normalizePos(lastPos);
      const n1 = normalizePos(pos);
      const action = {
        type: 'segment',
        x0: n0.x,
        y0: n0.y,
        x1: n1.x,
        y1: n1.y,
        color: activeColor,
        size: activeTool === 'eraser' ? activeSize * 3 : activeSize,
        isEraser: activeTool === 'eraser'
      };
      commitAndEmitAction(action);
      lastPos = pos;
      return;
    }

    // Aperçu en direct des formes géométriques sur previewCanvas
    clearPreview();
    const n0 = normalizePos(startPos);
    const n1 = normalizePos(pos);
    drawActionOnContext(previewCtx, {
      type: activeTool,
      x0: n0.x,
      y0: n0.y,
      x1: n1.x,
      y1: n1.y,
      color: activeColor,
      size: activeSize
    });
    lastPos = pos;
  }

  function handlePointerEnd(pos) {
    if (!isDrawing) return;
    isDrawing = false;
    clearPreview();

    if (activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle') {
      const n0 = normalizePos(startPos);
      const n1 = normalizePos(pos);
      if (Math.hypot(pos.x - startPos.x, pos.y - startPos.y) < 3) return;

      commitAndEmitAction({
        type: activeTool,
        x0: n0.x,
        y0: n0.y,
        x1: n1.x,
        y1: n1.y,
        color: activeColor,
        size: activeSize
      });
    }
  }

  // ==========================================================================
  // OUTIL TEXTE
  // ==========================================================================

  function showTextInputAt(pos) {
    pendingTextNorm = normalizePos(pos);
    dom.textInput.style.left = `${Math.min(pos.x, Math.max(0, dom.canvas.width - 180))}px`;
    dom.textInput.style.top = `${Math.min(pos.y, Math.max(0, dom.canvas.height - 40))}px`;
    dom.textInput.value = '';
    dom.textInput.classList.remove('hidden');
    dom.textInput.focus();
  }

  function hideTextInput() {
    pendingTextNorm = null;
    if (dom.textInput) dom.textInput.classList.add('hidden');
  }

  function commitTextInput() {
    if (!pendingTextNorm) return;
    const text = dom.textInput.value.trim();
    const coords = pendingTextNorm;
    hideTextInput();
    if (!text) return;

    commitAndEmitAction({
      type: 'text',
      x0: coords.x,
      y0: coords.y,
      text,
      color: activeColor,
      size: activeSize
    });
  }

  // ==========================================================================
  // RENDU CANVAS & SYNCHRONISATION SOCKET.IO
  // ==========================================================================

  function commitAndEmitAction(action) {
    localHistory.push(action);
    if (localHistory.length > 2000) localHistory.shift();
    drawActionOnContext(mainCtx, action);

    if (socketRef) {
      socketRef.emit('wb-draw', { roomId: roomIdRef, action });
    }
  }

  function registerSocketEvents() {
    if (!socketRef) return;

    socketRef.on('wb-draw', (action) => {
      if (!action) return;
      localHistory.push(action);
      if (localHistory.length > 2000) localHistory.shift();
      drawActionOnContext(mainCtx, action);
    });

    socketRef.on('wb-clear', () => {
      localHistory = [];
      clearMain();
    });

    socketRef.on('wb-toggle', ({ name, isOpen: opened }) => {
      if (opened && typeof MeetCommon !== 'undefined') {
        MeetCommon.showToast(`${name} a ouvert le tableau blanc`);
      }
    });
  }

  function drawActionOnContext(ctx, action) {
    if (!ctx || !action) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (!w || !h) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = action.size || 5;

    if (action.isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = action.color || '#ffffff';
      ctx.fillStyle = action.color || '#ffffff';
    }

    const x0 = (action.x0 || 0) * w;
    const y0 = (action.y0 || 0) * h;
    const x1 = (action.x1 || 0) * w;
    const y1 = (action.y1 || 0) * h;

    switch (action.type) {
      case 'segment':
      case 'line':
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        break;

      case 'rect':
        ctx.beginPath();
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        break;

      case 'circle': {
        const radius = Math.hypot(x1 - x0, y1 - y0);
        ctx.beginPath();
        ctx.arc(x0, y0, radius, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'text': {
        const fontSize = Math.max(14, (action.size || 5) * 3.2);
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(action.text || '', x0, y0);
        break;
      }

      default:
        break;
    }

    ctx.restore();
  }

  function clearMain() {
    if (mainCtx) {
      mainCtx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
    }
  }

  function clearPreview() {
    if (previewCtx) {
      previewCtx.clearRect(0, 0, dom.previewCanvas.width, dom.previewCanvas.height);
    }
  }

  function replayHistory() {
    clearMain();
    for (const action of localHistory) {
      drawActionOnContext(mainCtx, action);
    }
  }

  function exportAsPNG() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = dom.canvas.width;
    exportCanvas.height = dom.canvas.height;
    const ctx = exportCanvas.getContext('2d');

    // Appliquer la couleur de fond choisie (sombre ou claire) avant de copier les tracés
    ctx.fillStyle = isDarkTheme ? '#0f172a' : '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(dom.canvas, 0, 0);

    const a = document.createElement('a');
    a.href = exportCanvas.toDataURL('image/png');
    a.download = 'meetlite-tableau-blanc.png';
    document.body.appendChild(a);
    a.click();
    a.remove();

    if (typeof MeetCommon !== 'undefined') {
      MeetCommon.showToast('Tableau blanc exporté en PNG');
    }
  }

  return {
    init,
    open,
    close,
    toggle,
    loadHistory
  };
})();
