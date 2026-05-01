// claude-net service worker
//
// Minimal network-first strategy. Purpose is twofold:
//   1) Satisfy Chrome's installability criteria so the dashboard can be
//      added to the homescreen / Apps list as a PWA.
//   2) Show a stale cached shell if the hub is briefly unreachable —
//      the live data itself still requires the hub, so the UI will
//      reconnect as soon as the network returns.
//
// Cache discipline: only the fixed SHELL list is ever written to cache.
// Anything else is passed through untouched, so the cache cannot grow
// unbounded and cannot cache anything but the known set of shell
// assets. Bumping CACHE invalidates the set atomically — the activate
// handler drops every other cache key.

const CACHE = "claude-net-shell-v2";

// Pre-cached at install; also the exclusive allowlist for writes from
// the fetch handler. Keep this list in lockstep with what
// `src/hub/index.ts` serves as the app shell.
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/dashboard/parsers.js",
];
const SHELL_SET = new Set(SHELL);

// Exact and prefix matches the SW must NOT intercept. Live data
// (REST/WS), installer endpoints, binaries, and uploads must always hit
// the hub. The strings here are asserted in tests/hub/sw.test.ts — if
// you add a new live path to index.ts, update both.
const BYPASS_EXACT = new Set(["/plugin.ts", "/setup", "/health", "/ws"]);
const BYPASS_PREFIX = ["/api/", "/ws/", "/bin/", "/uploads/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function shouldBypass(path) {
  if (BYPASS_EXACT.has(path)) return true;
  for (const p of BYPASS_PREFIX) {
    if (path.startsWith(p)) return true;
  }
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (shouldBypass(url.pathname)) return;

  // Only shell paths participate in caching. Everything else is a pure
  // pass-through — no write, no cache fallback, no interception at all.
  if (!SHELL_SET.has(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        // resp.type === "basic" excludes opaque/CORS/redirected responses
        // which cannot be safely replayed from cache. Only clone and
        // store same-origin 2xx shell responses.
        if (resp?.ok && resp.type === "basic") {
          const clone = resp.clone();
          caches
            .open(CACHE)
            .then((c) => c.put(req, clone))
            .catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match("/"))),
  );
});
