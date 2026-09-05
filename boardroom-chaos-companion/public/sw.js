const CACHE = "boardroom-chaos-v1.5.0";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/engine.js", "/rules.js", "/properties.js", "/ai-providers.js", "/ai-prompts.js", "/js/helpers.js", "/js/store.js", "/js/ai.js", "/js/recorder.js", "/js/ui/shared.js", "/js/ui/dashboard.js", "/js/ui/actions.js", "/js/ui/market.js", "/js/ui/deals.js", "/js/ui/legal.js", "/js/ui/assets.js", "/js/ui/ledger.js", "/js/ui/rules.js", "/js/ui/voice.js", "/js/ui/settings.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(match => match || caches.match("/index.html"))));
});
