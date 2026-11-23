/**
 * sw.js — Service Worker léger pour MeetLite (PWA)
 * Met en cache les assets statiques du shell sans jamais intercepter
 * les requêtes temps réel (/socket.io, /api/, /health).
 */

const CACHE_NAME = 'meetlite-shell-v3';
const STATIC_ASSETS = [
  '/css/style.css?v=3',
  '/js/common.js',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  // Stratégie Network-First pour les pages HTML, Cache-First pour les assets statiques
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
