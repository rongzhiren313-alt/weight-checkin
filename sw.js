const CACHE_PREFIX = "weight-checkin-app";
const CACHE_NAME = "weight-checkin-app-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./core.js",
  "./storage.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/.netlify/functions")) return;
  url.search = "";
  url.hash = "";
  const isShell = SHELL_URLS.has(url.href);
  if (!isShell && event.request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request);
        if (isShell && response.ok && response.type === "basic") {
          await cache.put(url.href, response.clone()).catch(() => {});
        }
        return response;
      } catch (error) {
        const cached = isShell ? await cache.match(url.href) : undefined;
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const fallback = await cache.match(new URL("./index.html", self.registration.scope).href);
          if (fallback) return fallback;
        }
        throw error;
      }
    })()
  );
});
