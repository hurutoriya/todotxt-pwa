/* Todo.txt PWA Service Worker — GitHub Pages のサブパス対応のため相対パス基準
   HTML/JS/CSS は network-first（オンライン時は常に最新、オフライン時はキャッシュ）、
   画像は cache-first */
const CACHE = "todotxt-pwa-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/parser.js",
  "./js/file-manager.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const networkFirst =
    e.request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    /\.(js|css|html|webmanifest|json|txt)$/.test(url.pathname);
  if (networkFirst) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
