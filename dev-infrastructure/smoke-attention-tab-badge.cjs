// Built PWA + isolated in-memory inbox; no live notifications or conversations.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-tab-badge-"));
app.setPath("userData", path.join(directory, "profile"));
const assets = path.join(__dirname, "../dist/web"), streams = new Set(), sockets = new Set();
const item = (id, state = "pending") => ({ source: "fixture", id: String(id), title: `Badge fixture ${id}`, state, createdAt: 1, updatedAt: 1 });
let items = [item(1), item(2), item(3, "done")], window;
const publish = () => { for (const stream of streams) stream.write(`event: attention\ndata: ${JSON.stringify({ items })}\n\n`); };
const types = { "/": "text/html", "/index.js": "text/javascript", "/index.css": "text/css", "/sw.js": "text/javascript", "/manifest.webmanifest": "application/manifest+json", "/offline.html": "text/html", "/icon-192.png": "image/png", "/icon-512.png": "image/png" };
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://fixture").pathname;
  if (types[route]) {
    res.writeHead(200, { "Content-Type": types[route], "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(assets, route === "/" ? "index.html" : route.slice(1)))); return;
  }
  if (route === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" }); streams.add(res); res.on("close", () => streams.delete(res)); publish(); return;
  }
  if (route.endsWith("/state") && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    items.find(item => item.id === route.split("/")[4]).state = JSON.parse(body).state; publish();
  }
  const payload = route === "/api/session" ? { csrf: "fixture" } : route === "/api/attention" ? { items }
    : route === "/api/codex-instances" ? { supported: true, scanning: false, instances: [] } : {};
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload));
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(30); } throw Error("Timeout: " + label); }
const badgeIs = count => evaluate(count => {
  const tab = document.querySelector("#tab-attention-inbox"), badge = tab?.querySelector("[data-tab-badge]");
  return badge && badge.hidden === (count === 0) && badge.textContent === (count ? String(count) : "") &&
    tab.getAttribute("aria-label") === (count ? `Attention Inbox, ${count} pending` : "Attention Inbox");
}, count);
async function run() {
  await app.whenReady(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  window = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  await wait("initial pending count", () => badgeIs(2));
  await wait("live connection", () => evaluate(() => !document.querySelector("#online-controls").disabled));
  await evaluate(() => document.querySelector("#tab-codex-instances").click());
  items.push(item(4)); publish(); await wait("badge updates while another tab is selected", () => badgeIs(3));
  assert(await evaluate(() => document.querySelector("#tab-codex-instances").getAttribute("aria-selected") === "true"), "Count updates never switch tabs");
  await evaluate(() => document.querySelector("#tab-attention-inbox [data-tab-badge]").click());
  assert(await evaluate(() => document.querySelector("#tab-attention-inbox").getAttribute("aria-selected") === "true"), "Badge clicks select the inbox");
  for (const count of [2, 1, 0]) {
    await evaluate(() => {
      const card = [...document.querySelectorAll("article")].find(card => !card.hidden);
      card.querySelector("[data-attention-disclosure]").click();
      [...card.querySelectorAll("[data-card-actions] button")].find(button => button.textContent === "Done").click();
    });
    await wait("Done updates pending count", () => badgeIs(count));
  }
  await evaluate(() => [...document.querySelectorAll('nav[aria-label="Attention views"] button')].find(button => button.textContent.startsWith("Done")).click());
  assert(await badgeIs(0), "History does not contribute to badge");
  await evaluate(() => {
    const card = [...document.querySelectorAll("article")].find(card => !card.hidden);
    const disclosure = card.querySelector("[data-attention-disclosure]"); if (disclosure.getAttribute("aria-expanded") === "false") disclosure.click();
    [...card.querySelectorAll("[data-card-actions] button")].find(button => button.textContent === "Reopen").click();
  });
  await wait("Reopen updates count from history", () => badgeIs(1));
  await evaluate(() => document.querySelector("#tab-codex-instances").click());
  items = Array.from({ length: 100 }, (_, index) => item(index)); publish(); await wait("three-digit count", () => badgeIs(100));
  for (const width of [320, 390]) {
    window.setContentSize(width, 844);
    const layout = await evaluate(() => {
      const badge = document.querySelector("#tab-attention-inbox [data-tab-badge]"), bounds = badge.getBoundingClientRect();
      const tab = badge.parentElement.getBoundingClientRect();
      return { background: getComputedStyle(badge).backgroundColor, color: getComputedStyle(badge).color, badge: bounds.toJSON(), tab: tab.toJSON(), contentWidth: badge.scrollWidth, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    assert(layout.background === "rgb(220, 38, 38)" && layout.color === "rgb(255, 255, 255)" &&
      layout.badge.left >= layout.tab.left && layout.badge.right <= layout.tab.right && layout.badge.right <= layout.viewportWidth && Math.ceil(layout.badge.width) >= layout.contentWidth && layout.pageWidth <= layout.viewportWidth,
    "Red badge remains readable on narrow phones: " + JSON.stringify(layout));
  }
  window.showInactive(); await pause(100);
  fs.writeFileSync(path.join(directory, "phone-badge.png"), (await window.webContents.capturePage()).toPNG());
  items = []; publish(); await wait("removal hides badge", () => badgeIs(0));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["initial count", "live updates on other tabs", "badge click", "Done", "Reopen from history", "zero hidden", "three-digit narrow layout", "red styling and accessible name"], directory }, null, 2));
  console.log("PASS attention tab badge:", directory);
}
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => { console.error("Badge smoke timed out:", directory); app.exit(1); }, 30000);
function finish(code) { clearTimeout(watchdog); for (const socket of sockets) socket.destroy(); server.close(); app.exit(code); }
run().then(() => finish(0), error => { console.error(error, directory); finish(1); });
