const CACHE = 'final-projet-betax-v1';
const SHELL = [
  './', './index.html', './trajet.html', './bus.html', './ligne.html', './arret.html', './map.html', './contact.html', './offline.html',
  './css/style.css', './js/app.js', './js/bus.json', './js/stops.json', './js/data-meta.json', './manifest.webmanifest',
  './Image/logo.jpeg', './Image/ispm.jpeg', './Image/Bus.png', './Image/stop.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    const network = fetch(event.request).then((response) => {
      if (response && response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached || (event.request.mode === 'navigate' ? caches.match('./offline.html') : undefined));
    return cached || network;
  }));
});
