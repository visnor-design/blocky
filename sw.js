// Service worker: aplikácia funguje offline, ale ak si online, vždy sa načíta najnovšia verzia.
// Pri každej zmene súborov zvýš VERSION.
const VERSION = 'pokladna-v9';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'api.js', 'image.js', 'share.js', 'theme.js',
  'vendor/jsQR.js', 'manifest.webmanifest',
  'icons/logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' obíde HTTP cache, aby sa nestiahli staré súbory
    await Promise.all(SHELL.map(async (u) => {
      const res = await fetch(u, { cache: 'reload' });
      if (!res.ok) throw new Error('precache ' + u);
      await cache.put(u, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3500);   // pomalé spojenie: použije sa uložená kópia
  try {
    const res = await fetch(req.url, { cache: 'no-cache', signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) cache.put(req.url, res.clone());
    return res;
  } catch {
    clearTimeout(timer);
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Cudzie domény (napr. eKasa) a ne-GET požiadavky nikdy nekešujeme.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});
