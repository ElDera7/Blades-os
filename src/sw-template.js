/* BladeOS service worker — generated at build time (see vite.config.js). Lets the app open and sell with no internet.
   - App files (this build's list) are cached on install: the app opens offline.
   - Pages: network first (fresh when online), cached app when offline.
   - /api is never cached here — the app keeps its own offline copy and upload queue in IndexedDB.
   - A new version waits until the till says it's safe (between sales), then takes over. */
const VERSION = "__VERSION__";
const CACHE = `bladeos-${VERSION}`;
const FONTS = "bladeos-fonts";
const PRECACHE = __ASSETS__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", ...PRECACHE])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("bladeos-") && k !== CACHE && k !== FONTS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "version") e.source?.postMessage({ type: "version", version: VERSION });
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: keep a copy so the app looks right offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/downloads/") || url.pathname === "/health" || url.pathname === "/sw.js") return;

  // Pages: try the network briefly, fall back to the cached app.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const r = await Promise.race([fetch(req), timeout(4000)]);
        if (r.ok) { const c = await caches.open(CACHE); c.put("/", r.clone()); }
        return r;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // App files: cache first (file names change with every build).
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/products/"))) (await caches.open(CACHE)).put(req, r.clone());
    return r;
  })());
});
