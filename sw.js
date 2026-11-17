/* Répète — service worker.
   - Coque (page, scripts, styles, icônes) : RÉSEAU D'ABORD. En ligne, l'application se met à jour dès l'ouverture
     suivante (la copie du serveur est revalidée, sans passer par le cache HTTP de 10 min de GitHub Pages) ;
     hors ligne ou réseau trop lent (> 4 s), on sert la copie en cache.
   - Pièce par défaut (gros fichier) : CACHE D'ABORD, dans un cache séparé versionné par son contenu ; son
     préchargement ne bloque pas l'installation de la coque.
   - Les packs importés par l'utilisateur vivent dans IndexedDB, pas ici. */
var VERSION = '36c35abffc';
var CACHE = 'repete-shell-' + VERSION;
var SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
var CONTENT_CACHE = 'repete-content-98535b1fc8';
var CONTENT = ["./piece/defaut.theatrepack"];
var NETWORK_TIMEOUT = 4000;

// `cache: 'reload'` : ignorer le cache HTTP, sinon une version périmée (jusqu'à 10 min) pourrait être figée ici
function fresh(url) { return new Request(url, { cache: 'reload' }); }

function precacheContent() {
  if (!CONTENT.length) return Promise.resolve();
  return caches.open(CONTENT_CACHE).then(function (c) {
    return Promise.all(CONTENT.map(function (u) {
      return c.match(u).then(function (hit) { return hit || c.add(fresh(u)); });
    }));
  }).catch(function () { /* la pièce se mettra en cache à la première utilisation en ligne */ });
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(fresh(u)); }));
  }).then(precacheContent).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return (k.indexOf('repete-shell-') === 0 && k !== CACHE) || (k.indexOf('repete-content-') === 0 && k !== CONTENT_CACHE);
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isContent(url) {
  return CONTENT.some(function (u) { return new URL(u, self.location).pathname === url.pathname; });
}

function offlineFallback(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    if (req.mode === 'navigate') return caches.match('./index.html');
    return new Response('', { status: 504, statusText: 'Hors ligne' });
  });
}

function networkFirst(req) {
  var target = req.mode === 'navigate' ? req.url : req;
  var net = fetch(target, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  });
  var timer, slow = new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('lent')); }, NETWORK_TIMEOUT); });
  return Promise.race([net, slow]).then(function (res) { clearTimeout(timer); return res; })
    .catch(function () { clearTimeout(timer); return offlineFallback(req); });
}

function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CONTENT_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return new Response('', { status: 504, statusText: 'Hors ligne' }); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(isContent(url) ? cacheFirst(req) : networkFirst(req));
});
