// Renderer protocol and draft/deep-link smoke in Chromium. Android notification
// activation and Firefox's choice of standalone/task remain physical-device checks.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-notification-click-"));
app.setPath("userData", path.join(directory, "profile"));
const assets = path.join(__dirname, "../dist/web"), sockets = new Set();
const completion = "completion-" + "a".repeat(64), targetId = "notification-target";
const items = [
  { source: "codex", id: completion, title: "Codex done: Draft fixture", codexSessionId: "fixture", state: "pending", createdAt: 1, updatedAt: 1 },
  { source: "fixture", id: targetId, title: "Notification target", state: "done", createdAt: 2, updatedAt: 2 },
];
const types = { "/": "text/html", "/index.js": "text/javascript", "/index.css": "text/css", "/sw.js": "text/javascript", "/manifest.webmanifest": "application/manifest+json", "/offline.html": "text/html", "/icon-192.png": "image/png", "/icon-512.png": "image/png" };
let window;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture"), route = url.pathname;
  if (types[route]) {
    res.writeHead(200, { "Content-Type": types[route], "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(assets, route === "/" ? "index.html" : route.slice(1)))); return;
  }
  if (route === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    res.write(`event: attention\ndata: ${JSON.stringify({ items })}\n\n`); return;
  }
  const payload = route === "/api/session" ? { csrf: "fixture" }
    : route === "/api/attention" ? { items }
    : route === "/api/codex-instances" ? { instances: [], supported: true, scanning: false }
    : route.endsWith("/questions") ? [] : {};
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload));
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function wait(label, predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error("Timeout: " + label);
}
async function run() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, width: 412, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  await window.loadURL(origin);
  await wait("inbox", () => evaluate(() => Boolean(document.querySelector('[data-codex-message] [data-message-input]'))));
  const query = () => evaluate(() => new Promise((resolve, reject) => {
    const channel = new MessageChannel(), timer = setTimeout(() => reject(new Error("Display mode query timed out")), 2000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(event.data); };
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "attention-client-info" }, ports: [channel.port2] }));
  }));
  assert.deepEqual(await query(), { type: "attention-client-info", standalone: false });
  // Electron has no installed-PWA display mode. Supply that browser result to
  // exercise the standalone branch; this does not validate Android app launch.
  await evaluate(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = matchMedia(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  assert.deepEqual(await query(), { type: "attention-client-info", standalone: true });
  await evaluate(() => {
    const card = document.querySelector('[data-codex-message]').closest("article");
    card.querySelector('[data-attention-disclosure]').click();
    const input = card.querySelector('[data-message-input]');
    window.retainedNotificationDraft = input;
    if (input.tagName === "TEXTAREA") input.value = "Keep my unsent instruction"; else input.textContent = "Keep my unsent instruction";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#tab-codex-instances").click();
  });
  const open = url => evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "attention-open", url } })), url);
  const target = `${origin}/#item=${encodeURIComponent(JSON.stringify(["fixture", targetId]))}`;
  await open(target);
  await wait("Done deep link", () => evaluate(() => document.querySelector('#tab-attention-inbox').getAttribute('aria-selected') === "true"
    && [...document.querySelectorAll("article")].some(card => card.querySelector("h3")?.textContent === "Notification target" && !card.querySelector('[data-attention-body]').hidden)));
  assert.equal(await evaluate(() => window.retainedNotificationDraft.textContent || window.retainedNotificationDraft.value), "Keep my unsent instruction");
  await evaluate(() => {
    const card = [...document.querySelectorAll("article")].find(card => card.querySelector("h3")?.textContent === "Notification target");
    card.querySelector('[data-attention-disclosure]').click();
  });
  await open(target);
  await wait("repeated notification expands target", () => evaluate(() => [...document.querySelectorAll("article")].some(card => card.querySelector("h3")?.textContent === "Notification target" && !card.querySelector('[data-attention-body]').hidden)));
  const before = await evaluate(() => location.href);
  for (const url of ["http://[", "https://other.test/", origin + "/api/attention"]) await open(url);
  assert.equal(await evaluate(() => location.href), before);
  await evaluate(() => [...document.querySelectorAll('nav[aria-label="Attention views"] button')].find(button => button.textContent.startsWith("Pending")).click());
  assert.equal(await evaluate(() => document.querySelector('[data-codex-message] [data-message-input]') === window.retainedNotificationDraft), true, "The draft DOM survives notification navigation");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["browser and simulated standalone replies", "notification selects inbox and Done target", "repeat click expands target", "same draft DOM retained", "invalid URLs ignored"], directory }, null, 2));
  console.log("PASS notification-click browser smoke:", directory);
}
const watchdog = setTimeout(() => { console.error("Notification smoke timed out"); finish(1); }, 30000);
function finish(code) { clearTimeout(watchdog); window?.destroy(); for (const socket of sockets) socket.destroy(); server.close(); app.exit(code); }
run().then(() => finish(0), error => { console.error(error); finish(1); });
