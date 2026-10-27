// Built PWA, isolated inbox fixtures. Never sends live notifications or messages.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-pending-default-"));
app.setPath("userData", path.join(directory, "profile"));
const assets = path.join(__dirname, "../dist/web"), sockets = new Set(), streams = new Set();
const item = (id, state) => ({ source: "fixture", id, title: id, state, createdAt: 1, updatedAt: 1 });
let items = [item("finished", "done")], window;
const publish = () => { for (const stream of streams) stream.write(`event: attention\ndata: ${JSON.stringify({ items })}\n\n`); };
const types = { "/": "text/html", "/index.js": "text/javascript", "/index.css": "text/css", "/sw.js": "text/javascript", "/manifest.webmanifest": "application/manifest+json", "/offline.html": "text/html", "/icon-192.png": "image/png", "/icon-512.png": "image/png" };
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://fixture").pathname;
  if (types[route]) {
    res.writeHead(200, { "Content-Type": types[route], "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(assets, route === "/" ? "index.html" : route.slice(1)))); return;
  }
  if (route === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" }); streams.add(res);
    res.on("close", () => streams.delete(res)); publish(); return;
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
const selected = () => evaluate(() => document.querySelector('nav[aria-label="Attention views"] [aria-pressed="true"]')?.textContent);
const select = name => evaluate(name => [...document.querySelectorAll('nav[aria-label="Attention views"] button')].find(button => button.textContent.startsWith(name)).click(), name);
async function assertEmptyPending(label) {
  assert.equal(await selected(), "Pending (0)", label);
  assert(await evaluate(() => document.querySelector("#attention-inbox").textContent.includes("No pending items.") &&
    ![...document.querySelectorAll("article")].some(card => !card.hidden)), "Empty Pending never shows history cards");
}
async function run() {
  await app.whenReady(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const linked = id => `${origin}/#item=${encodeURIComponent(JSON.stringify(["fixture", id]))}`;
  window = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  let launch = 0;
  const load = async url => {
    const target = new URL(url); target.searchParams.set("launch", String(++launch));
    await window.loadURL(target.href);
    await wait("connected", () => evaluate(() => !document.querySelector("#online-controls")?.disabled &&
      Boolean(document.querySelector('nav[aria-label="Attention views"] [aria-pressed="true"]'))));
  };
  await load(origin);
  await assertEmptyPending("History-only inbox defaults to Pending");
  // A saved notification fragment must not override the default after reload.
  await load(linked("finished"));
  await assertEmptyPending("A restored Done notification URL defaults to Pending");
  await select("Done"); assert.equal(await selected(), "Done (1)");
  items.push(item("finished-again", "done")); publish();
  await wait("explicit Done selection survives updates", async () => (await selected()) === "Done (2)");
  await evaluate(() => { document.querySelector("#tab-codex-instances").click(); document.querySelector("#tab-attention-inbox").click(); });
  assert.equal(await selected(), "Done (2)", "Manual filter selection survives section switches");
  await load(linked("finished")); await assertEmptyPending("Reload resets a manually selected Done view");
  items.push(item("last-pending", "pending")); publish();
  await wait("new pending item", async () => (await selected()) === "Pending (1)");
  await evaluate(() => {
    const card = [...document.querySelectorAll("article")].find(card => !card.hidden);
    card.querySelector("[data-attention-disclosure]").click();
    [...card.querySelectorAll("[data-card-actions] button")].find(button => button.textContent === "Done").click();
  });
  await wait("last pending item completed", async () => (await selected()) === "Pending (0)");
  await assertEmptyPending("Completing the last item leaves Pending selected");
  // Explicit notification clicks still navigate to their target, including history.
  await evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "attention-open", url } })), linked("finished"));
  await wait("explicit notification opens history", async () => (await selected()) === "Done (3)");
  await load(linked("finished")); await assertEmptyPending("Reload after a notification returns to Pending");
  items = [item("waiting", "pending")];
  await load(linked("waiting"));
  assert.equal(await selected(), "Pending (1)");
  assert(await evaluate(() => document.querySelector("[data-attention-disclosure]").getAttribute("aria-expanded") === "true"), "Pending notification targets still expand on startup");
  items = []; await load(origin); await assertEmptyPending("An entirely empty inbox defaults to Pending");
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["history-only startup", "restored Done link", "manual Done selection retained", "reload resets to Pending", "last pending completed", "explicit notification navigation", "pending link expands", "empty inbox"], directory }, null, 2));
  console.log("PASS attention Pending default:", directory);
}
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => { console.error("Pending default smoke timed out:", directory); finish(1); }, 30000);
function finish(code) { clearTimeout(watchdog); window?.destroy(); for (const socket of sockets) socket.destroy(); server.close(); app.exit(code); }
run().then(() => finish(0), error => { console.error(error, directory); finish(1); });
