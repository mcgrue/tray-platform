// Phone-sized PWA smoke with isolated backend fixtures; no live Codex delivery.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-web-turn-controls-")), root = path.join(__dirname, "..");
app.setPath("userData", path.join(directory, "profile"));
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "attention-service", "web-receipts", "web-push-service", "codex-instance-service"]
  .map(name => `export * from './src/main/${name}';`).concat("export * from './src/shared/codex-turn-controls';").join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, AttentionService, WebReceipts, WebPushService, CodexInstanceService, CodexTurnNotStartedError } = require(path.join(directory, "backend.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 20000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw Error("Timeout: " + label); }
let web, proxy, window, attention, push, instances;
const sockets = new Set();
async function run() {
  await app.whenReady();
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  await attention.upsert("codex", "notice", { title: "Fixture attention", codexSessionId: "session" });
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]);
  await push.initialize(attention.list());
  const instance = { codexPid: 42, codexStartedAt: "2026-11-11T10:00:00Z", vscodePid: 12,
    vscodeStartedAt: "2026-11-11T09:00:00Z", vscodeMainPid: 12, title: "Fixture project", workspace: "D:/fixture" };
  instances = new CodexInstanceService({ supported: true, scan: async () => ({ instances: [instance] }) }); await instances.refresh();
  const catalog = { available: true, current: { model: "model-a", effort: "medium" }, models: [{
    id: "model-a", name: "Model A", defaultEffort: "medium", efforts: [{ id: "medium", description: "Balanced" }, { id: "high", description: "Deeper" }],
  }] };
  const sent = []; let rejectFirst = true;
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"),
    operations: { questions: async () => [], turnSettings: async () => catalog,
      message: async (_source, _id, message, options) => { sent.push({ surface: "inbox", message, options });
        return { sessionId: "session", turnId: "turn-inbox", delivery: "started" }; } },
    codex: { instances, messages: { conversations: async () => [], turnSettings: async () => catalog,
      send: async (_target, _conversation, message, options) => { if (rejectFirst) { rejectFirst = false;
          throw new CodexTurnNotStartedError("Codex is working. Wait for this turn to finish; your draft is preserved."); }
        sent.push({ surface: "instance", message, options });
        return { sessionId: "created", turnId: "turn-instance", delivery: "started" }; } } },
  });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  config.origin = `http://127.0.0.1:${proxy.address().port}`;
  window = new BrowserWindow({ width: 412, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await window.loadURL(config.origin);
  await wait("connected", () => evaluate(() => document.querySelector("#connection").dataset.connected === "true" && !!document.querySelector('[data-codex-pid="42"]')));
  await evaluate(() => { document.querySelector("#tab-codex-instances").click(); document.querySelector("[data-instance-menu-toggle]").click();
    document.querySelector("[data-instance-menu] [data-message-codex]").click(); });
  await wait("instance controls", () => evaluate(() => !document.querySelector("[data-codex-instance-composer] [data-codex-turn-controls] select").disabled));
  await evaluate(() => {
    const selects = document.querySelectorAll("[data-codex-instance-composer] [data-codex-turn-controls] select");
    selects[0].value = "plan"; selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    selects[2].value = "high"; selects[2].dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector("[data-codex-instance-composer] [data-message-input]");
    input.textContent = "Plan from phone"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait("instance selection ready", () => evaluate(() => { const panel = document.querySelector("[data-codex-instance-composer]");
    return !panel.querySelector("[type=submit]").disabled && panel.querySelector("[data-codex-turn-controls] select").value === "plan"; }));
  await evaluate(() => document.querySelector("[data-codex-instance-composer] [type=submit]").click());
  await wait("active rejection", () => evaluate(() => { const panel = document.querySelector("[data-codex-instance-composer]");
    return panel.querySelector('[role="alert"]').textContent.includes("Codex is working") &&
      panel.querySelector('[data-message-input]').textContent === "Plan from phone" &&
      panel.querySelector('[data-codex-turn-controls] select').value === "plan" && !panel.querySelector('[type="submit"]').disabled; }));
  await evaluate(() => document.querySelector("[data-codex-instance-composer] [type=submit]").click());
  await wait("instance send", () => sent.length === 1);
  assert.deepEqual(sent[0], { surface: "instance", message: "Plan from phone", options: { mode: "plan", effort: "high" } });
  await evaluate(() => { document.querySelector("#tab-attention-inbox").click();
    document.querySelector('[data-attention-disclosure]').click();
    const details = document.querySelector("[data-codex-message]"); if (details.tagName === "DETAILS") details.open = true; });
  await wait("inbox controls", () => evaluate(() => !document.querySelector("#attention-inbox [data-codex-turn-controls] select").disabled));
  await evaluate(() => {
    const controls = document.querySelector("#attention-inbox [data-codex-turn-controls]");
    const selects = controls.querySelectorAll("select");
    selects[0].value = "plan"; selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    selects[2].value = "high"; selects[2].dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector("#attention-inbox [data-codex-message] [data-message-input]");
    input.textContent = "Plan inbox from phone"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#attention-inbox [data-codex-message] [type=submit]").click();
  });
  await wait("inbox send", () => sent.length === 2);
  assert.deepEqual(sent[1], { surface: "inbox", message: "Plan inbox from phone", options: { mode: "plan", effort: "high" } });
  for (const width of [360, 412]) { window.setSize(width, 900); await sleep(80);
    assert(await evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}px`); }
  fs.writeFileSync(path.join(directory, "phone-turn-controls.png"), (await window.webContents.capturePage()).toPNG());
  console.log("PASS PWA turn controls smoke:", directory);
}
const watchdog = setTimeout(() => { console.error("PWA turn controls smoke timed out"); finish(1); }, 90000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); window?.destroy(); web?.close(); for (const socket of sockets) socket.destroy();
  proxy?.close(); instances?.close(); attention?.close(); push?.close(); app.exit(code); }
