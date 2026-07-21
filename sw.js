const CACHE = 'stm-buses-v1';
const ASSETS = [
  '/stm-monitor/reporte-buses-stm.html',
  '/stm-monitor/stm-logic.js',
  '/stm-monitor/stm_data.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', e => {
  // Los datos en tiempo real siempre van a la red
  if (e.request.url.includes('workers.dev') || e.request.url.includes('montevideo.gub.uy')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
