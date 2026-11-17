/* Répète — service worker : la coque de l'application est mise en cache à la première visite, puis servie
   sans réseau. Il ne met en cache AUCUN contenu de pièce (les packs vivent dans IndexedDB). */
var VERSION = 'b31b75c0a2';
var CACHE = 'repete-shell-' + VERSION;
var SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./demo/essai.theatrepack"];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('repete-shell-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return cache.match('./index.html');
        return new Response('', { status: 504, statusText: 'Hors ligne' });
      });
    });
  }));
});
