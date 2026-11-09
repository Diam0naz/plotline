// Service worker: the app shell is cached on install so Plotline opens with no network.
// Map tiles are cached as they are viewed, so areas you have already looked at stay visible offline.
const VERSION = 'plotline-v22'; // bump on shell changes: the fetch handler is cache-first, so a stale version keeps serving the old app forever
const SHELL = [
  './',
  './index.html',
  './app.html',
  './site.css',
  './style.css',
  './app.js',
  './core.js',
  './sw-update.js',
  './manifest.webmanifest',
  './icon.svg',
  './assets/leaf-pattern.svg',
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
const TILES = 'plotline-tiles-v2'; // bumped from v1: the old store had no expiry metadata; activate deletes it
const MAX_TILES = 400;
// OSM policy §3.2: honour server caching headers, or cache each tile for at
// least 7 days if you cannot read them. We can read them (with crossOrigin),
// so each stored tile records its expiry from Cache-Control, defaulting to
// the 7-day floor when a server response carries none.
const TILE_MIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

// sw-update.js asks the waiting worker to take over immediately, so new
// shells upgrade automatically instead of waiting for every tab to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

function tileMaxAgeMs(res) {
  const cc = res.headers.get('cache-control') || '';
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cc);
  const parsed = m ? Number(m[1]) * 1000 : 0;
  return parsed > 0 ? parsed : TILE_MIN_MAX_AGE_MS;
}

// Cache-first with expiry, per OSM tile policy §3.2:
// - fresh store (x-expires-at in the future, or older entries without one)
//   is served locally, so repeat views never re-download tiles;
// - expired entries are revalidated by a plain re-fetch (the browser adds
//   If-None-Match/If-Modified-Since automatically against OSM's Etags) and
//   the response is re-stored with a new expiry;
// - only res.ok responses are stored — blocked/403/broken responses never
//   poison the cache;
// - offline with no fresh entry serves the stale tile rather than nothing,
//   keeping the "areas you have already looked at stay visible offline" promise.
async function handleTile(req) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(req);
  if (cached) {
    const expires = Number(cached.headers.get('x-expires-at') || 0);
    if (!expires || Date.now() < expires) return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set('x-expires-at', String(Date.now() + tileMaxAgeMs(res)));
      // Stored as a plain 200 Response: inherits status/headers minus our
      // marker, and keeps an Etag the browser can revalidate with later.
      await cache.put(req, new Response(body, { status: 200, headers }));
      trimTiles(cache);
    }
    return res;
  } catch {
    // No network: stale beats a hard error when we've seen the tile before.
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first with expiry, filled as the user browses.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(handleTile(req));
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
