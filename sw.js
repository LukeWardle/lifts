/* Service worker: the whole app opens with no signal.
 *
 * Unlike the laptop app's worker, there is no server behind this one to fall
 * back on — the plan itself lives in localStorage — so the shell is cached on
 * install and served from the cache when the network is slow or gone.
 *
 * Network first, but only for a couple of seconds. Waiting on a dead signal in
 * a basement gym is the failure that matters; a stale app for one load after
 * an update is not. Bump CACHE when the files change.
 */

const CACHE = "lifts-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];
const NETWORK_WAIT_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow")), NETWORK_WAIT_MS);
    fetch(request).then((res) => {
      clearTimeout(timer);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      resolve(res);
    }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Fonts never change at a given URL: the cache first, always.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fromNetwork(event.request).catch(() =>
      caches.match(event.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match("./index.html")))
  );
});
