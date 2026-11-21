// Offline cache. App code (html/js/css) comes from the network first so updates show at once;
// the big book files come from the cache first (refreshed in the background). Offline: everything from cache.
const CACHE = "sherlock-reader-v3";
const FILES = ["./", "index.html", "app.css", "app.js", "book/book.json", "book/audio.json", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // audio streams straight from archive.org
  const code = e.request.mode === "navigate" || /\.(html|js|css|webmanifest)$|\/$/.test(url.pathname);
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = () => c.match(e.request, { ignoreSearch: true });
    const net = () => fetch(e.request, code ? { cache: "no-cache" } : {}).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (code) return net().catch(async () => (await hit()) || Response.error());
    const h = await hit();
    const n = net().catch(() => h);
    return h || n;
  }));
});
