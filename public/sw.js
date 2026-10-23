// Minimal offline shell. Caches the app UI so it opens instantly on the trail.
// Writing a poem still needs a connection (the model runs in the cloud).
//
// Network-first: when online we always fetch the latest HTML/JS/CSS, so a stale
// cached app.js can never run against a newer index.html (that mismatch is what
// throws "Cannot set properties of null"). The cache is only used offline.
const CACHE = 'haikamera-shell-v22';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Leave cross-origin requests and the API alone.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Keep a copy for offline use, but always serve the fresh response.
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('/index.html'))
      )
  );
});
