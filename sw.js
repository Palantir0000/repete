/* Répète — service worker : la coque de l'application est mise en cache à la première visite, puis servie
   sans réseau. Les packs importés par l'utilisateur vivent dans IndexedDB, pas ici. La pièce par défaut
   éventuelle est préchargée dans un cache séparé (versionné par son contenu), sans bloquer l'installation. */
var VERSION = '75fe261fc0';
var CACHE = 'repete-shell-' + VERSION;
var SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
var CONTENT_CACHE = 'repete-content-98535b1fc8';
var CONTENT = ["./piece/defaut.theatrepack"];

function precacheContent() {
  if (!CONTENT.length) return Promise.resolve();
  return caches.open(CONTENT_CACHE).then(function (c) {
    return Promise.all(CONTENT.map(function (u) {
      return c.match(u).then(function (hit) { return hit || c.add(u); });
    }));
  }).catch(function () { /* la pièce se mettra en cache à la première utilisation en ligne */ });
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
    .then(precacheContent).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return (k.indexOf('repete-shell-') === 0 && k !== CACHE) || (k.indexOf('repete-content-') === 0 && k !== CONTENT_CACHE);
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var name = CONTENT.some(function (u) { return new URL(u, self.location).pathname === url.pathname; }) ? CONTENT_CACHE : CACHE;
        var copy = res.clone();
        caches.open(name).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      if (req.mode === 'navigate') return caches.match('./index.html');
      return new Response('', { status: 504, statusText: 'Hors ligne' });
    });
  }));
});
