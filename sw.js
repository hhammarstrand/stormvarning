/* Stormvarning service worker
 * Nätverk-först för ALLT (skal + data), cache som reserv vid offline.
 *
 * Viktigt: tidigare version serverade skalet cache-först, men eftersom sw.js
 * i sig aldrig ändrades mellan deployer fastnade installerade klienter på en
 * gammal version av appen för alltid. Nätverk-först gör att även en gammal
 * service worker alltid hämtar färskt skal när nätet finns.
 */
var CACHE = "stormvarning-v2";
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
  if (url.origin !== self.location.origin) return; // rör inte externa anrop

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // Offline: cachad version om den finns, annars startsidan för navigering.
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") return caches.match("index.html");
        return Response.error();
      });
    })
  );
});
