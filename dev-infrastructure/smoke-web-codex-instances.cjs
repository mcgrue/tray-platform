// Phone-sized Chromium + authenticated web routes; no messages to live Codex sessions.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-web-instances-")), root = path.join(__dirname, "..");
console.log("PWA Codex evidence:", directory);
app.setPath("userData", path.join(directory, "profile"));
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "attention-service", "web-receipts", "web-push-service", "codex-instance-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, AttentionService, WebReceipts, WebPushService, CodexInstanceService } = require(path.join(directory, "backend.cjs"));
let web, proxy, window, attention, push, instances;
const sockets = new Set(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 20000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw Error("Timeout: " + label); }
async function run() {
  await app.whenReady();
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  const rows = [42, 99].map((codexPid, i) => ({ codexPid, codexStartedAt: "2026-10-24T10:00:00Z", vscodePid: codexPid + 1,
    vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 1, title: ["Breaditor", "Tray Platform"][i],
    workspace: ["D:/dev/grue/breaditor-v2", "D:/dev/grue/tray-platform"][i], activity: i ? "idle" : "working", activityCheckedAt: Date.now() }));
  instances = new CodexInstanceService({ supported: true, scan: async () => ({ instances: rows }) }); await instances.refresh();
  const sent = [];
  let dropNext = false, holdNext = false, releaseHeld, offline = false;
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: { questions: async () => [] },
    codex: { instances, messages: {
      conversations: async target => target.codexPid === 42 ? [{ id: "saved", title: "Existing project conversation", lastActiveAt: Date.now() }] : [],
      send: async (target, conversationId, message) => {
        sent.push({ target, conversationId, message });
        return { sessionId: conversationId || `created-${sent.length}`, turnId: "turn", delivery: "started" };
      },
    } },
  });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    if (offline) { res.destroy(); return; }
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => {
        if (dropNext && req.url.endsWith("/messages")) { dropNext = false; response.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{"); return; }
        if (holdNext && req.url.endsWith("/messages")) {
          holdNext = false; response.resume(); releaseHeld = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{"); }; return;
        }
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  await attention.upsert("codex", "notice", { title: "Fixture notification", codexSessionId: "fixture" });
  window = new BrowserWindow({ width: 412, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = []; window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await window.loadURL(config.origin);
  await wait("connected instances", () => evaluate(() => document.querySelector("#connection").dataset.connected === "true" && document.querySelectorAll("[data-codex-pid]").length === 2));
  assert.equal(await evaluate(() => typeof window.ipcComms), "undefined");
  const tab = id => evaluate(id => document.querySelector(`#tab-${id}`).click(), id);
  await tab("codex-instances");
  assert(await evaluate(() => !document.querySelector("#codex-instances").hidden && document.querySelector("#attention-inbox").hidden));
  assert.equal(await evaluate(() => document.querySelectorAll(".codex-activity-legend [data-codex-activity]").length), 4);
  for (const width of [360, 412]) {
    window.setSize(width, 900); await sleep(80);
    assert(await evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal page scrolling at ${width}px`);
    assert(await evaluate(() => [...document.querySelectorAll("[data-message-codex]")].every(node => {
      const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth;
    })), "Message actions fit phone width");
  }
  window.showInactive(); await sleep(100);
  fs.writeFileSync(path.join(directory, "phone-instances.png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  await evaluate(() => { const sort = document.querySelector("[data-instance-sort] select"); sort.value = "codexPid:descending"; sort.dispatchEvent(new Event("change")); });
  assert.equal(await evaluate(() => document.querySelector("[data-codex-pid]").dataset.codexPid), "99");
  const open = pid => evaluate(pid => document.querySelector(`[data-codex-pid="${pid}"] [data-message-codex]`).click(), pid);
  const read = () => evaluate(() => { const panel = document.querySelector("[data-codex-instance-composer]"); return {
    text: panel.querySelector("textarea").value, selected: panel.querySelector("select").value, choices: panel.querySelector("select").options.length,
    disabled: panel.querySelector('[type="submit"]').matches(":disabled"), status: panel.querySelector('[role="status"]').textContent,
    error: panel.querySelector('[role="alert"]').textContent,
  }; });
  const type = text => evaluate(text => { const input = document.querySelector("[data-codex-instance-composer] textarea"); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  const choose = value => evaluate(value => { const select = document.querySelector("[data-codex-instance-composer] select"); select.value = value; select.dispatchEvent(new Event("change")); }, value);
  const send = () => evaluate(() => document.querySelector('[data-codex-instance-composer] [type="submit"]').click());
  await open(42); await wait("saved choices", async () => (await read()).choices === 2);
  await type("Retain this phone draft"); await tab("attention-inbox"); await tab("codex-instances");
  assert.equal((await read()).text, "Retain this phone draft");
  rows[0].activity = "waiting"; rows[0].activityCheckedAt = Date.now(); await instances.refresh();
  await wait("live activity", () => evaluate(() => document.querySelector('[data-codex-pid="42"] [data-codex-activity]').dataset.codexActivity === "waiting"));
  assert.equal((await read()).text, "Retain this phone draft");
  await choose("saved"); await send(); await wait("existing sent", async () => !(await read()).text);
  assert.deepEqual(sent[0], { target: { codexPid: 42, codexStartedAt: rows[0].codexStartedAt }, conversationId: "saved", message: "Retain this phone draft" });
  await open(99); await wait("empty project", async () => (await read()).status.includes("No saved conversations"));
  await type("Create from the phone"); assert(!(await read()).disabled);
  dropNext = true; await send();
  await wait("lost acknowledgement", async () => (await read()).error.includes("unconfirmed"));
  await send(); await sleep(100); assert.equal(sent.length, 2, "Unconfirmed new thread is not created twice");
  await evaluate(() => document.querySelector("#check-delivery").click());
  await wait("new receipt recovered", async () => (await read()).selected === "created-2" && !(await read()).text);
  assert.equal(sent[1].conversationId, ""); assert.equal(sent.length, 2);
  dropNext = true; await type("Delivered follow-up"); await send();
  await wait("follow-up unconfirmed", async () => (await read()).error.includes("unconfirmed"));
  await type("Newer unsent draft");
  await evaluate(() => document.querySelector("#check-delivery").click());
  await wait("recovered without wiping edit", async () => (await read()).status.includes("current draft is preserved"));
  assert.equal((await read()).text, "Newer unsent draft"); assert.equal(sent.length, 3);
  holdNext = true; await send(); await wait("held acknowledgement", () => releaseHeld);
  assert((await read()).disabled);
  await evaluate(() => document.querySelector("#check-delivery").click());
  await wait("recovered while original request remains pending", async () => !(await read()).text && !(await read()).error);
  await type("Next retained draft"); releaseHeld(); await sleep(100);
  assert.equal((await read()).error, "", "Late transport failure cannot overwrite recovered success");
  assert.equal((await read()).text, "Next retained draft"); assert.equal(sent.length, 4);
  await attention.setState("codex", "notice", "done");
  await evaluate(() => { location.hash = "item=" + encodeURIComponent(JSON.stringify(["codex", "notice"])); });
  await wait("notification opens inbox", () => evaluate(() => document.querySelector("#tab-attention-inbox").getAttribute("aria-selected") === "true" && document.querySelector('nav[aria-label="Attention views"] [aria-pressed="true"]').textContent.startsWith("Done")));
  await tab("codex-instances"); assert.equal((await read()).text, "Next retained draft");
  window.showInactive(); await sleep(100);
  fs.writeFileSync(path.join(directory, "phone-composer.png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  offline = true; for (const socket of sockets) socket.destroy();
  await wait("offline controls", async () => (await read()).disabled);
  await evaluate(() => document.querySelector("[data-codex-instance-composer] textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  await sleep(100); assert.equal(sent.length, 4, "Keyboard shortcuts cannot send through a disabled fieldset");
  await tab("attention-inbox"); await tab("codex-instances"); assert.equal((await read()).text, "Next retained draft");
  offline = false;
  await evaluate(() => document.querySelector("#refresh").click());
  await wait("reconnected", () => evaluate(() => document.querySelector("#connection").dataset.connected === "true"));
  assert.equal(sent.length, 4, "Reconnect never replays messages");
  assert.equal((await read()).text, "Next retained draft");
  assert.equal(errors.filter(message => !/Failed to load resource|ERR_/.test(message)).length, 0, errors.join("\n"));
  console.log("PASS PWA Codex tab: mobile cards, sort, live activity, saved/new messages, tab drafts, lost-response recovery, notification routing, offline/reconnect");
}
const watchdog = setTimeout(() => { console.error("PWA Codex smoke timed out"); finish(1); }, 90000);
function finish(code) { clearTimeout(watchdog); window?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); instances?.close(); attention?.close(); push?.close(); app.exit(code); }
run().then(() => finish(0), error => { console.error(error); finish(1); });
