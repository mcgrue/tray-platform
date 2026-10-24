/* CACHE_VERSION is replaced with a build content hash. No API data is cached. */
const CACHE = "tray-shell-CACHE_VERSION";
const SHELL = ["/offline.html", "/index.css", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  // Wait for existing clients to close; never replace a page with an active draft.
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("tray-shell-") && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html"))); return;
  }
  if (SHELL.includes(new URL(event.request.url).pathname)) event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch { /* Show a useful generic notification. */ }
    const url = typeof data.url === "string" && data.url.startsWith("/#item=") ? data.url : "/";
    await self.registration.showNotification(typeof data.title === "string" ? data.title : "Tray Platform", {
      body: typeof data.body === "string" ? data.body : "Attention is needed on your desktop.",
      icon: "/icon-192.png", badge: "/icon-192.png", tag: typeof data.tag === "string" ? data.tag : "tray-attention", data: { url },
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "/", self.location.origin);
    if (target.origin !== self.location.origin) return;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = clients.find(value => new URL(value.url).origin === self.location.origin);
    if (client) { client.postMessage({ type: "attention-open", url: target.href }); await client.focus(); }
    else await self.clients.openWindow(target.href);
  })());
});
