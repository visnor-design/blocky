// Service worker: aplikácia funguje offline (app shell sa kešuje).
// Pri každej zmene súborov zvýš VERSION, aby sa kešu obnovili.
const VERSION = 'pokladna-v6';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'api.js', 'image.js', 'share.js', 'theme.js',
  'vendor/jsQR.js', 'manifest.webmanifest',
  'icons/logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Cudzie domény (napr. eKasa) a ne-GET požiadavky nikdy nekešujeme.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() =>
      req.mode === 'navigate' ? caches.match('index.html') : Response.error()
    ))
  );
});
