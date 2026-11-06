// Service worker: the app shell is cached on install so Plotline opens with no network.
// Map tiles are cached as they are viewed, so areas you have already looked at stay visible offline.
const VERSION = 'plotline-v7';
const SHELL = [
  './',
  './index.html',
  './app.html',
  './site.css',
  './style.css',
  './app.js',
  './core.js',
  './manifest.webmanifest',
  './icon.svg',
  './assets/monstera/pattern.jpg',
  './assets/monstera/pattern-dark.jpg',
  './assets/monstera/pattern-mist.jpg',
  './assets/monstera/leaf.png',
  './assets/monstera/leaf-dark.png',
  './assets/monstera/leaf-mist.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet-heat.js',
];
const TILES = 'plotline-tiles-v1';
const MAX_TILES = 400;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first, filled as the user browses.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) { cache.put(req, res.clone()); trimTiles(cache); }
          return res;
        } catch {
          return new Response('', { status: 504, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  // Ledger calls always go to the network; never answer them from the cache.
  if (url.pathname.includes('/api/')) return;

  // App shell: cache-first for our own files. Only page navigations fall back to index.html.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    )
  );
});
