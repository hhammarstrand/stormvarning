/* Stormvarning service worker
 * Skalfiler cachas (app-shell) för offline/installbarhet. Data (data.json /
 * history.json) hämtas alltid nätverk-först så lägesbilden aldrig blir gammal.
 */
var CACHE = "stormvarning-v1";
var SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  var isData = url.pathname.endsWith("data.json") || url.pathname.endsWith("history.json");

  if (isData) {
    // Nätverk först, cache som reserv (t.ex. offline).
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return caches.match(req); })
    );
  } else {
    // Skalfiler: cache först, nätverk som reserv.
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
  }
});
