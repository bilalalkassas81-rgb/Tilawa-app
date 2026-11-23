// Offline support: app shell + Qur'an text are cached on install; translations and audio are cached as you use them.
const VERSION = 'tilawa-v1.4.0';
const SHELL = ['./', 'index.html', 'css/app.css', 'css/fonts.css', 'js/app.js', 'js/match.js', 'js/speech.js', 'js/store.js', 'js/meta.js',
  'data/quran.json', 'data/pages.json', 'data/lines.json', 'data/imlai.json', 'fonts/UthmanicHafs-v-3.0.ttf', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/amiri-quran-arabic-400-normal.woff2', 'fonts/readex-pro-latin-400-normal.woff2', 'fonts/readex-pro-latin-500-normal.woff2', 'fonts/readex-pro-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'tilawa-audio').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // cache-first for our files, refreshed in the background
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
