// After yarn pre-build: electron dev-infrastructure/smoke-codex-messages.cjs
// Set CODEX_CLI to the extension-bundled runtime. Retains isolated evidence.
// Uses a fixture extension router and real Codex app-server; never sends to a live conversation.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { app } = require("electron");
const { createMessageRuntime } = require("./codex-message-runtime.cjs");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-messages-"));
const reportPath = path.join(dataPath, "result.json");
app.setName("Tray Codex messages smoke " + process.pid);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40); }
  throw new Error("Timeout: " + label);
}
const frame = message => { const bytes = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); };
let runtime, router, application, failed = false;
const sockets = new Set();
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the extension-bundled codex.exe");
  runtime = await createMessageRuntime(dataPath, process.env.CODEX_CLI);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tray-message-smoke-${process.pid}` : path.join(dataPath, "router.sock");
  let mode = "send", releaseDelivery, deliveryCalls = 0;
  const handle = async (socket, message) => {
    if (message.type !== "request") return;
    let result;
    try {
      if (message.method === "initialize") result = { clientId: "smoke-client" };
      else if (message.method === "thread-owner-discovery") {
        assert.equal(message.params.conversationId, runtime.sessionId); assert.equal(message.version, 1);
        if (mode === "missing") throw new Error("no-client-found");
        result = { supportsUntrustedAppInput: true };
      } else {
        assert.equal(message.targetClientId, "smoke-owner");
        assert.equal(message.version, message.method === "thread-follower-steer-turn" ? 1 : 2);
        deliveryCalls++;
        if (mode === "delay") await new Promise(resolve => { releaseDelivery = resolve; });
        if (mode === "disconnect") { socket.destroy(); return; }
        result = await runtime.send(message.method, message.params);
      }
      if (socket.writable) socket.write(frame({ type: "response", requestId: message.requestId, method: message.method, handledByClientId: "smoke-owner", resultType: "success", result }));
    } catch (error) {
      if (socket.writable) socket.write(frame({ type: "response", requestId: message.requestId, resultType: "error", error: error.message }));
    }
  };
  router = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", bytes => { buffer = Buffer.concat([buffer, bytes]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const size = buffer.readUInt32LE(), message = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); void handle(socket, message);
    } });
  });
  await new Promise(resolve => router.listen(endpoint, resolve));
  application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow, attention, codexMessages } = application;
  mainWindow.webContents.setAudioMuted(true); mainWindow.hide();
  const createClient = codexMessages.createClient;
  codexMessages.createClient = () => { const client = createClient(); client.endpoint = endpoint; return client; };
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await attention.upsert("codex", "message-smoke", { title: "Codex message delivery", codexSessionId: runtime.sessionId, project: dataPath });
  await attention.upsert("other", "other", { title: "Unrelated item" });
  await waitFor("composer", () => evaluate(() => !!document.querySelector('[data-codex-message]:not([hidden])')));
  assert.equal(await evaluate(() => document.querySelectorAll('[data-codex-message]:not([hidden])').length), 1, "Other sources have no composer");
  const read = () => evaluate(() => {
    const root = document.querySelector('[data-codex-message]:not([hidden])');
    return { value: root.querySelector("textarea").value, disabled: root.querySelector("button").disabled, status: root.querySelector('[role="status"]').textContent, error: root.querySelector('[role="alert"]').textContent };
  });
  const type = text => evaluate(text => { const root = document.querySelector('[data-codex-message]:not([hidden])'); root.open = true; const input = root.querySelector("textarea"); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  const send = () => evaluate(() => document.querySelector('[data-codex-message]:not([hidden]) button').click());
  assert.equal((await read()).disabled, true);
  const first = 'Literal café 🙂\n<script>not markup</script> $(literal)';
  await type(first);
  await attention.upsert("other", "other", { title: "Notification arrived while drafting" });
  await sleep(100); assert.equal((await read()).value, first);
  await evaluate(() => document.querySelector('[data-codex-message]:not([hidden]) textarea')
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  await waitFor("idle follow-up acknowledged", async () => (await read()).status === "Sent to Codex as a follow-up.");
  await waitFor("runtime received first message", () => runtime.requests.some(request => JSON.stringify(request).includes(JSON.stringify(first).slice(1, -1))));
  await waitFor("idle turn completed", () => runtime.completed.size === 1);
  assert.equal((await read()).value, "");
  assert.equal(attention.get("codex", "message-smoke").state, "pending");

  runtime.holdNextResponse();
  await type("Begin held turn"); await send();
  await waitFor("held turn started", async () => (await read()).status === "Sent to Codex as a follow-up." && runtime.requests.length >= 2);
  mode = "delay"; await type("Steer this running fixture"); await send();
  await waitFor("delayed delivery", () => !!releaseDelivery);
  assert.equal((await read()).disabled, true);
  assert.equal((await read()).value, "Steer this running fixture");
  const before = deliveryCalls; await send(); await sleep(100); assert.equal(deliveryCalls, before);
  mode = "send"; releaseDelivery();
  await waitFor("steering acknowledged", async () => (await read()).status === "Sent to the active Codex turn.");
  runtime.releaseResponse();
  await waitFor("runtime consumed steering", () => runtime.requests.some(request => JSON.stringify(request).includes("Steer this running fixture")));

  mode = "missing"; await type("Retain this failed draft"); await send();
  await waitFor("missing owner feedback", async () => (await read()).error.includes("conversation is unavailable"));
  assert.equal((await read()).value, "Retain this failed draft");
  assert.equal((await read()).disabled, false);
  mode = "disconnect"; await send();
  await waitFor("unconfirmed delivery feedback", async () => (await read()).error.includes("Check the conversation"));
  assert.equal((await read()).value, "Retain this failed draft");
  assert.equal(attention.get("codex", "message-smoke").state, "pending");
  await evaluate(() => document.querySelector('[data-codex-message]:not([hidden])').scrollIntoView({ block: "center" }));
  mainWindow.showInactive(); await sleep(200);
  const screenshot = await mainWindow.webContents.capturePage();
  assert(!screenshot.isEmpty()); fs.writeFileSync(path.join(dataPath, "composer.png"), screenshot.toPNG()); mainWindow.hide();
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, checks: ["real Electron IPC and named pipe", "real runtime idle turn", "real runtime steering", "duplicate send prevention", "snapshot draft retention", "missing owner", "unknown delivery retains draft", "pending state preserved"] }, null, 2));
  console.log("Codex message smoke passed:", reportPath);
}
const watchdog = setTimeout(() => { console.error("Smoke timed out"); app.exit(1); }, 90000);
run().catch(error => { failed = true; console.error(error); fs.writeFileSync(reportPath, JSON.stringify({ passed: false, dataPath, error: error.stack || String(error) }, null, 2)); }).finally(async () => {
  clearTimeout(watchdog); await runtime?.close(); for (const socket of sockets) socket.destroy(); router?.close();
  app.once("will-quit", () => app.exit(failed ? 1 : 0)); app.quit();
});
