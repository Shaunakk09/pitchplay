// PitchPlay PWA: fetch the latest app shell first while retaining offline editing.
// Private tactics live in IndexedDB; Supabase requests bypass this cache.
const CACHE = 'pitchplay-shell-v3';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pitchplay-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          // Never cache query strings containing authentication codes.
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname === '/cloud-config.js' || url.pathname === '/sw.js') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match(request) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Vite fingerprints asset names, so immutable files are safe to cache.
    event.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }));
    return;
  }
  event.respondWith(fetch(request).then(async response => {
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  }).catch(async () => (await caches.open(CACHE)).match(request) || Response.error()));
});
