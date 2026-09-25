/* English Buddy service worker.
 * Strategy:
 *  - page navigations  -> network-first, cached fallback when offline
 *  - built/static files -> cache-first, network fallback, runtime-populated
 *  - /api/*            -> network only (never cached; offline queue handles this)
 *  - non-GET requests  -> never intercepted
 */

const CACHE_VERSION = "english-buddy-v2";
const PRECACHE_URLS = [
  "/",
  "/history",
  "/dashboard",
  "/call",
  "/me",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // allSettled: one missing asset must not block SW installation.
      await Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isNavigation(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" && request.destination === "document")
  );
}

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") ||
      /\.(?:js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp3)$/i.test(
        url.pathname
      ))
  );
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Offline and no exact page copy: fall back to the app shell.
    const shell = await cache.match("/");
    if (shell) return shell;
    return new Response("Offline", {
      status: 503,
      statusText: "Offline",
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only; let the browser handle cross-origin requests.
  if (url.origin !== self.location.origin) return;

  // API calls are always live (ASR/LLM/TTS + DB sync). Offline sends are
  // queued in IndexedDB by the app, not cached here.
  if (url.pathname.startsWith("/api/")) return;

  if (isNavigation(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Any other same-origin GET: network-first with cache fallback.
  event.respondWith(networkFirst(request));
});
