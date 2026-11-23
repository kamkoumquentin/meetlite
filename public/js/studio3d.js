/**
 * studio3d.js — Studio 3D Collaboratif (Three.js + OrbitControls + GLTFLoader + Socket.io)
 *
 * Fonctionnalités :
 *  - 3 assemblages procéduraux détaillés : Arduino Uno, Véhicule/Châssis, Tuyauterie industrielle
 *  - Import de modèles .glb / .gltf locaux partagés en temps réel (jusqu'à 8 Mo)
 *  - Vue éclatée radiale (0..100) fonctionnelle sur modèles procéduraux et .glb importés
 *  - Pointeur / Repères 3D par Raycaster (double-clic ou double-tap sur mobile)
 *  - Synchronisation caméra enseignant -> étudiants (throttlée 60 ms)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let socketRef = null;
let roomIdRef = '';
let userNameRef = '';
let isHostRef = false;
let onToggleCallback = null;

let isOpen = false;
let syncCameraActive = false;
let isApplyingRemoteCamera = false;
let lastCameraEmitAt = 0;
let lastTapAt = 0;

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let animFrameId = null;

let currentModelGroup = null;
let pinsGroup = null;
const activePins = [];

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const gltfLoader = new GLTFLoader();

const dom = {};

function init({ socket, roomId, userName, isHost, onToggle }) {
  socketRef = socket;
  roomIdRef = roomId;
  userNameRef = userName;
  isHostRef = Boolean(isHost);
  onToggleCallback = onToggle;
  syncCameraActive = isHostRef;

  dom.container = document.getElementById('studio3dContainer');
  dom.mount = document.getElementById('canvas3dMount');
  dom.modelSelect = document.getElementById('model3dSelect');
  dom.importInput = document.getElementById('import3dInput');
  dom.explodeSlider = document.getElementById('explode3dSlider');
  dom.syncCameraBtn = document.getElementById('syncCamera3dBtn');
  dom.clearPinsBtn = document.getElementById('clearPins3dBtn');
  dom.closeBtn = document.getElementById('close3dBtn');

  if (!dom.container || !dom.mount) return;

  dom.syncCameraBtn.classList.toggle('active', syncCameraActive);

  setupThreeScene();
  bindUIEvents();
  registerSocketEvents();
  loadBuiltInModel('arduino', { emit: false });
}

// ============================================================================
// INITIALISATION THREE.JS
// ============================================================================

function setupThreeScene() {
  scene = new THREE.Scene();

  const w = dom.mount.clientWidth || 640;
  const h = dom.mount.clientHeight || 420;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(3.8, 2.8, 4.4);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  dom.mount.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 14;

  // Éclairage studio + HemisphereLight de secours
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 1.5);
  scene.add(hemiLight);

  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(5, 8, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
  fillLight.position.set(-5, 3, -4);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
  grid.position.y = -1.1;
  scene.add(grid);

  pinsGroup = new THREE.Group();
  scene.add(pinsGroup);

  // Redimensionnement automatique
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeRenderer).observe(dom.mount);
  } else {
    window.addEventListener('resize', resizeRenderer);
  }

  // Synchronisation caméra throttlée (60 ms)
  controls.addEventListener('change', () => {
    if (!syncCameraActive || isApplyingRemoteCamera || !isOpen || !socketRef) return;
    const now = Date.now();
    if (now - lastCameraEmitAt < 60) return;
    lastCameraEmitAt = now;

    socketRef.emit('3d-camera-sync', {
      roomId: roomIdRef,
      position: camera.position.toArray(),
      target: controls.target.toArray()
    });
  });

  startRenderLoop();
}

function resizeRenderer() {
  if (!renderer || !camera || !dom.mount) return;
  const w = dom.mount.clientWidth || window.innerWidth || 640;
  const h = dom.mount.clientHeight || Math.max(240, window.innerHeight - 140);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function startRenderLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  let frameCounter = 0;
  const tick = () => {
    animFrameId = requestAnimationFrame(tick);
    frameCounter += 1;
    if (frameCounter % 120 === 0) {
      console.log('[3D] F - rendu actif, isOpen =', isOpen, 'enfants scène =', scene.children.length);
    }
    if (!isOpen) return;

    controls.update();

    // Animation pulsante sur les repères 3D
    const pulse = 1 + Math.sin(Date.now() * 0.006) * 0.18;
    for (const pin of activePins) {
      if (pin.sphere) pin.sphere.scale.setScalar(pulse);
    }

    renderer.render(scene, camera);
  };
  tick();
}

// ============================================================================
// OUVERTURE / FERMETURE & RESTAURATION D'ÉTAT
// ============================================================================

function open({ remote = false } = {}) {
  if (isOpen) return;
  isOpen = true;
  dom.container.classList.remove('hidden');
  if (onToggleCallback) onToggleCallback(true);

  if (!renderer) {
    setupThreeScene();
  }
  if (!currentModelGroup) {
    loadBuiltInModel('arduino', { emit: false });
  }

  requestAnimationFrame(() => {
    resizeRenderer();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  });

  if (!remote && socketRef) {
    socketRef.emit('3d-state-change', {
      roomId: roomIdRef,
      open: true,
      name: userNameRef
    });
  }
}

function close({ remote = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  dom.container.classList.add('hidden');
  if (onToggleCallback) onToggleCallback(false);

  if (!remote && socketRef) {
    socketRef.emit('3d-state-change', {
      roomId: roomIdRef,
      open: false,
      name: userNameRef
    });
  }
}

function toggle() {
  if (isOpen) close({ remote: false });
  else open({ remote: false });
}

function loadState(state) {
  if (!state) return;

  if (state.modelType === 'custom' && state.glbData) {
    loadGLBFromBase64(state.glbData, state.fileName || 'Modèle importé');
  } else if (state.modelType) {
    dom.modelSelect.value = state.modelType;
    loadBuiltInModel(state.modelType, { emit: false });
  }

  if (typeof state.explode === 'number') {
    dom.explodeSlider.value = String(state.explode);
    applyExplode(state.explode);
  }

  if (Array.isArray(state.pins)) {
    clearLocalPins();
    state.pins.forEach((pin) => createPinMesh(pin));
  }

  if (state.camera?.position && state.camera?.target) {
    applyRemoteCamera(state.camera);
  }

  if (state.open) {
    open({ remote: true });
  }
}

// ============================================================================
// ÉVÉNEMENTS UI & RAYCASTER (REPÈRES 3D)
// ============================================================================

function bindUIEvents() {
  dom.closeBtn.addEventListener('click', () => close({ remote: false }));

  dom.modelSelect.addEventListener('change', (e) => {
    const modelType = e.target.value;
    loadBuiltInModel(modelType, { emit: true });
  });

  dom.importInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    console.log('[3D] A - fichier choisi', file?.name, file?.size);
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      if (window.MeetCommon) MeetCommon.showToast('Fichier trop volumineux (max 8 Mo).');
      e.target.value = '';
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      parseGLBBuffer(arrayBuffer, file.name);

      if (socketRef) {
        const base64Data = arrayBufferToBase64(arrayBuffer);
        socketRef.emit('3d-select-model', {
          roomId: roomIdRef,
          modelType: 'custom',
          glbData: base64Data,
          fileName: file.name
        });
      }
    } catch (err) {
      console.error('[Studio3D] Erreur GLTF:', err);
      if (window.MeetCommon) {
        MeetCommon.showToast(`Erreur import 3D : ${err?.message || 'lecture impossible'}`);
      }
    } finally {
      e.target.value = '';
    }
  });

  dom.explodeSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    applyExplode(val);
    if (socketRef) {
      socketRef.emit('3d-explode', { roomId: roomIdRef, value: val });
    }
  });

  dom.syncCameraBtn.addEventListener('click', () => {
    syncCameraActive = !syncCameraActive;
    dom.syncCameraBtn.classList.toggle('active', syncCameraActive);
    if (window.MeetCommon) {
      MeetCommon.showToast(syncCameraActive ? 'Synchronisation caméra activée' : 'Caméra libre');
    }
  });

  dom.clearPinsBtn.addEventListener('click', () => {
    if (socketRef) {
      socketRef.emit('3d-clear-pins', { roomId: roomIdRef });
    } else {
      clearLocalPins();
    }
  });

  // Double-clic desktop pour placer un repère 3D
  renderer.domElement.addEventListener('dblclick', (e) => {
    placePinFromPointer(e.clientX, e.clientY);
  });

  // Double-tap mobile pour placer un repère 3D
  renderer.domElement.addEventListener('touchend', (e) => {
    const now = Date.now();
    const touch = e.changedTouches?.[0];
    if (touch && now - lastTapAt < 300) {
      placePinFromPointer(touch.clientX, touch.clientY);
      lastTapAt = 0;
    } else {
      lastTapAt = now;
    }
  });
}

function placePinFromPointer(clientX, clientY) {
  if (!currentModelGroup) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(currentModelGroup.children, true);
  if (!hits.length) return;

  const pt = hits[0].point;
  const pin = {
    x: Number(pt.x.toFixed(3)),
    y: Number(pt.y.toFixed(3)),
    z: Number(pt.z.toFixed(3)),
    label: `#${activePins.length + 1}`
  };

  createPinMesh(pin);
  if (socketRef) {
    socketRef.emit('3d-add-pin', { roomId: roomIdRef, pin });
  }
}

function createPinMesh(pin) {
  const sphereGeo = new THREE.SphereGeometry(0.075, 16, 16);
  const sphereMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.85
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.position.set(pin.x, pin.y, pin.z);

  const sprite = createPinLabelSprite(pin.label || `#${activePins.length + 1}`);
  sprite.position.set(pin.x, pin.y + 0.22, pin.z);

  pinsGroup.add(sphere);
  pinsGroup.add(sprite);
  activePins.push({ sphere, sprite, data: pin });
}

function createPinLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(14, 10, 100, 44, 14);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 33);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.45, 0.22, 1);
  return sprite;
}

function clearLocalPins() {
  while (pinsGroup.children.length > 0) {
    const child = pinsGroup.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  }
  activePins.length = 0;
}

// ============================================================================
// SYNCHRONISATION SOCKET.IO
// ============================================================================

function registerSocketEvents() {
  if (!socketRef) return;

  socketRef.on('3d-state-change', ({ open: shouldOpen, openedBy } = {}) => {
    if (shouldOpen) {
      open({ remote: true });
      if (openedBy && openedBy !== userNameRef && window.MeetCommon) {
        MeetCommon.showToast(`${openedBy} a ouvert le Studio 3D`);
      }
    } else {
      close({ remote: true });
    }
  });

  socketRef.on('3d-select-model', ({ modelType, glbData, fileName } = {}) => {
    if (modelType === 'custom' && glbData) {
      loadGLBFromBase64(glbData, fileName || 'Modèle partagé');
    } else if (modelType) {
      dom.modelSelect.value = modelType;
      loadBuiltInModel(modelType, { emit: false });
    }
  });

  socketRef.on('3d-camera-sync', applyRemoteCamera);

  socketRef.on('3d-explode', ({ value } = {}) => {
    const num = Number(value) || 0;
    dom.explodeSlider.value = String(num);
    applyExplode(num);
  });

  socketRef.on('3d-add-pin', (pin) => {
    if (pin) createPinMesh(pin);
  });

  socketRef.on('3d-clear-pins', clearLocalPins);
}

function applyRemoteCamera({ position, target }) {
  if (!position || !target || !camera || !controls) return;
  isApplyingRemoteCamera = true;
  camera.position.fromArray(position);
  controls.target.fromArray(target);
  controls.update();
  isApplyingRemoteCamera = false;
}

// ============================================================================
// GESTION DES MODÈLES & VUE ÉCLATÉE
// ============================================================================

function setCurrentModel(group) {
  if (currentModelGroup) {
    scene.remove(currentModelGroup);
  }
  clearLocalPins();
  dom.explodeSlider.value = '0';

  currentModelGroup = group;
  prepareExplodableModel(currentModelGroup);
  scene.add(currentModelGroup);
  console.log('[3D] E - ajouté à la scène, enfants =', scene.children.length);
}

function loadBuiltInModel(type, { emit = true } = {}) {
  let group = null;
  if (type === 'vehicle') group = buildVehicleModel();
  else if (type === 'piping') group = buildPipingModel();
  else group = buildArduinoModel();

  setCurrentModel(group);

  if (emit && socketRef) {
    socketRef.emit('3d-select-model', {
      roomId: roomIdRef,
      modelType: type
    });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64Str) {
  const clean = base64Str.includes(',') ? base64Str.split(',')[1] : base64Str;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function loadGLBFromBase64(base64Data, fileName) {
  try {
    const buffer = base64ToArrayBuffer(base64Data);
    parseGLBBuffer(buffer, fileName);
  } catch (err) {
    console.error('[Studio3D] Erreur GLTF:', err);
    if (window.MeetCommon) {
      MeetCommon.showToast(`Erreur décodage 3D : ${err?.message || 'données invalides'}`);
    }
  }
}

function parseGLBBuffer(arrayBuffer, fileName) {
  console.log('[3D] B - avant parse, buffer =', arrayBuffer.byteLength);
  gltfLoader.parse(
    arrayBuffer,
    '',
    (gltf) => {
      console.log('[3D] C - onLoad appelé', gltf);
      const root = gltf.scene || gltf.scenes?.[0];
      if (!root) {
        const err = new Error('Scène 3D vide dans le fichier.');
        console.error('[Studio3D] Erreur GLTF:', err);
        if (window.MeetCommon) MeetCommon.showToast(`Erreur import 3D : ${err.message}`);
        return;
      }

      const diagBox = new THREE.Box3().setFromObject(root);
      console.log('[3D] D - size:', diagBox.getSize(new THREE.Vector3()), 'center:', diagBox.getCenter(new THREE.Vector3()));

      // Normalisation des normales et matériaux
      enhanceModelMaterials(root);

      // Mise à l'échelle à 3 unités max et centrage sur (0, 0, 0)
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 3.0 / maxDim;
      root.scale.multiplyScalar(scale);

      root.updateMatrixWorld(true);
      const scaledBox = new THREE.Box3().setFromObject(root);
      const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
      root.position.sub(scaledCenter);

      const wrapper = new THREE.Group();
      wrapper.add(root);
      setCurrentModel(wrapper);

      // Replacer la caméra face au modèle importé
      camera.position.set(4, 3, 5);
      controls.target.set(0, 1, 0);
      controls.update();
      resizeRenderer();

      if (window.MeetCommon) {
        console.log('[3D] G - message "fichier chargé" affiché');
        MeetCommon.showToast(`Modèle chargé : ${fileName}`);
      }
    },
    (err) => {
      console.error('[3D] ERREUR parse', err);
      console.error('[Studio3D] Erreur GLTF:', err);
      const reason = err?.message || 'format .glb/.gltf invalide ou textures externes manquantes';
      if (window.MeetCommon) {
        MeetCommon.showToast(`Erreur import 3D : ${reason}`);
      }
    }
  );
}

function enhanceModelMaterials(model) {
  model.traverse((child) => {
    if (!child.isMesh) return;

    if (child.geometry && !child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals();
    }

    const fixMat = (mat) => {
      if (!mat) {
        return new THREE.MeshStandardMaterial({
          color: 0x60a5fa,
          roughness: 0.4,
          metalness: 0.3,
          side: THREE.DoubleSide
        });
      }
      const isBlackWithoutMap = !mat.map && mat.color && mat.color.r === 0 && mat.color.g === 0 && mat.color.b === 0;
      if (isBlackWithoutMap) {
        return new THREE.MeshStandardMaterial({
          color: 0x60a5fa,
          roughness: 0.4,
          metalness: 0.3,
          side: THREE.DoubleSide
        });
      }
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
      return mat;
    };

    child.material = Array.isArray(child.material)
      ? child.material.map(fixMat)
      : fixMat(child.material);
  });
}

function prepareExplodableModel(group) {
  enhanceModelMaterials(group);
  const groupBox = new THREE.Box3().setFromObject(group);
  const groupCenter = groupBox.getCenter(new THREE.Vector3());

  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    obj.userData.basePos = obj.position.clone();

    const meshBox = new THREE.Box3().setFromObject(obj);
    const meshCenter = meshBox.getCenter(new THREE.Vector3());
    const dir = meshCenter.sub(groupCenter);
    if (dir.lengthSq() < 0.0001) {
      dir.set(0, 1, 0);
    } else {
      dir.normalize();
    }
    obj.userData.explodeDir = dir;
  });
}

function applyExplode(value) {
  if (!currentModelGroup) return;
  const factor = (Number(value) || 0) / 100 * 1.4;

  currentModelGroup.traverse((obj) => {
    if (!obj.isMesh || !obj.userData.basePos || !obj.userData.explodeDir) return;
    obj.position.copy(obj.userData.basePos).addScaledVector(obj.userData.explodeDir, factor);
  });
}

// ============================================================================
// GÉNÉRATEURS PROCÉDURAUX (ARDUINO, VÉHICULE, TUYAUTERIE)
// ============================================================================

function buildArduinoModel() {
  const group = new THREE.Group();

  // PCB bleu Arduino
  const pcb = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.12, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x006699, roughness: 0.45, metalness: 0.1 })
  );
  group.add(pcb);

  // Port USB métallique
  const usb = new THREE.Mesh(
    new THREE.BoxGeometry(0.65, 0.42, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.25, metalness: 0.85 })
  );
  usb.position.set(-1.35, 0.27, -0.45);
  group.add(usb);

  // Prise Jack alimentation
  const jack = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.4, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 })
  );
  jack.position.set(-1.35, 0.26, 0.58);
  group.add(jack);

  // Puce ATmega328P
  const mcu = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.16, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 })
  );
  mcu.position.set(0.35, 0.14, 0.2);
  group.add(mcu);

  // Quartz 16MHz
  const crystal = new THREE.Mesh(
    new THREE.BoxGeometry(0.38, 0.14, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.2 })
  );
  crystal.position.set(-0.4, 0.13, -0.1);
  group.add(crystal);

  // Barrettes de pins noires (Digital + Analog/Power)
  const headerMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 });
  const topHeader = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.26, 0.16), headerMat);
  topHeader.position.set(0.3, 0.19, -0.92);
  group.add(topHeader);

  const bottomHeader = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.26, 0.16), headerMat);
  bottomHeader.position.set(0.35, 0.19, 0.92);
  group.add(bottomHeader);

  // Condensateurs électrolytiques
  const capMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.3 });
  [-0.7, -0.42].forEach((xPos) => {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.32, 16), capMat);
    cap.position.set(xPos, 0.22, 0.55);
    group.add(cap);
  });

  // LED verte ON
  const led = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.08, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 0.9 })
  );
  led.position.set(1.15, 0.1, -0.4);
  group.add(led);

  return group;
}

function buildVehicleModel() {
  const group = new THREE.Group();

  // Châssis principal
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.28, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.6, roughness: 0.4 })
  );
  chassis.position.set(0, -0.15, 0);
  group.add(chassis);

  // Cabine / Carrosserie supérieure
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.72, 1.32),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.35, metalness: 0.25 })
  );
  cabin.position.set(-0.2, 0.35, 0);
  group.add(cabin);

  // Pare-brise
  const windshield = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.5, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.15, metalness: 0.5 })
  );
  windshield.position.set(0.7, 0.38, 0);
  group.add(windshield);

  // Bloc moteur central avant
  const engine = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.45, 0.85),
    new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.75, roughness: 0.3 })
  );
  engine.position.set(1.05, 0.2, 0);
  group.add(engine);

  // Essieux + 4 roues
  const axleMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.2 });

  [-1.05, 1.05].forEach((xPos) => {
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 12), axleMat);
    axle.rotation.x = Math.PI / 2;
    axle.position.set(xPos, -0.35, 0);
    group.add(axle);

    [-0.92, 0.92].forEach((zPos) => {
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.26, 24), tireMat);
      tire.rotation.x = Math.PI / 2;
      tire.position.set(xPos, -0.35, zPos);
      group.add(tire);

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.28, 16), rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(xPos, -0.35, zPos);
      group.add(rim);
    });
  });

  return group;
}

function buildPipingModel() {
  const group = new THREE.Group();
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.8, roughness: 0.3 });
  const flangeMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });

  // Tuyau horizontal principal
  const mainPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 2.4, 24), steelMat);
  mainPipe.rotation.z = Math.PI / 2;
  mainPipe.position.set(-0.4, -0.3, 0);
  group.add(mainPipe);

  // Coude 90° (Torus)
  const elbow = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.32, 20, 24, Math.PI / 2), steelMat);
  elbow.position.set(0.8, 0.3, 0);
  elbow.rotation.z = -Math.PI / 2;
  group.add(elbow);

  // Tuyau vertical
  const riserPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.4, 24), steelMat);
  riserPipe.position.set(1.4, 1.0, 0);
  group.add(riserPipe);

  // Bride boulonnée
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.14, 24), flangeMat);
  flange.rotation.z = Math.PI / 2;
  flange.position.set(-1.55, -0.3, 0);
  group.add(flange);

  const boltMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9 });
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), boltMat);
    bolt.rotation.z = Math.PI / 2;
    bolt.position.set(-1.55, -0.3 + Math.cos(angle) * 0.43, Math.sin(angle) * 0.43);
    group.add(bolt);
  }

  // Corps de vanne + tige + volant rouge
  const valveBody = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.55, 20), flangeMat);
  valveBody.position.set(-0.4, -0.3, 0);
  group.add(valveBody);

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.65, 12), boltMat);
  stem.position.set(-0.4, 0.28, 0);
  group.add(stem);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4, metalness: 0.2 });
  const handwheel = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.06, 12, 24), wheelMat);
  handwheel.rotation.x = Math.PI / 2;
  handwheel.position.set(-0.4, 0.62, 0);
  group.add(handwheel);

  return group;
}

window.MeetStudio3D = {
  init,
  open,
  close,
  toggle,
  loadState
};

window.dispatchEvent(new Event('meet-studio3d-ready'));
