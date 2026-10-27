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
// WindowClient does not expose display-mode. Ask each pane without waking it by
// navigation; a suspended/older pane must not hold up the notification click.
function isStandaloneClient(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = standalone => {
      clearTimeout(timeout);
      channel.port1.close(); channel.port2.close();
      resolve(standalone);
    };
    const timeout = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = event => finish(event.data?.type === "attention-client-info" && event.data.standalone === true);
    try { client.postMessage({ type: "attention-client-info" }, [channel.port2]); }
    catch { finish(false); }
  });
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target;
    try { target = new URL(event.notification.data?.url || "/", self.location.origin); }
    catch { return; }
    if (target.origin !== self.location.origin || target.pathname !== "/") return;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let candidates = clients.filter(client => {
      const url = new URL(client.url);
      return url.origin === target.origin && url.pathname === "/" && client.frameType !== "nested";
    });
    if (candidates.length > 1) {
      const ranked = await Promise.all(candidates.map(async client => ({ client, standalone: await isStandaloneClient(client) })));
      candidates = ranked.sort((a, b) => Number(b.standalone) - Number(a.standalone)).map(value => value.client);
    }
    for (const client of candidates) {
      try {
        await client.focus();
        client.postMessage({ type: "attention-open", url: target.href });
        return;
      } catch { /* A pane can close between matchAll and focus. Try another. */ }
    }
    // The browser decides whether a cold start opens standalone or in a tab.
    const opened = await self.clients.openWindow(target.href);
    if (opened) {
      try { await opened.focus(); } catch { /* The target is already open. */ }
    }
  })());
});
