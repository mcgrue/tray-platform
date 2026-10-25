// Real desktop IPC and phone HTTP renderers share isolated approval callbacks.
// No live Codex operation is requested or approved.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
require("./smoke-environment.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-approval-smoke-")), root = path.join(__dirname, "..");
console.log("Approval smoke evidence:", directory);
app.setName(`Tray approvals ${process.pid}`);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: directory, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, WebReceipts, WebPushService } = require(path.join(directory, "backend.cjs"));
let application, phone, web, proxy, push, unsubscribePush, dropNext = false;
const sockets = new Set(), errors = [], pushes = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const card = (window, id, action, decision) => evaluate(window, (id, action, decision) => {
  const node = [...document.querySelectorAll("article")].find(node => node.dataset.attentionKey === JSON.stringify(["codex-approval", id]));
  if (!node) return null;
  if (action === "expand") { const toggle = node.querySelector("[data-attention-disclosure]"); if (toggle?.getAttribute("aria-expanded") === "false") toggle.click(); }
  if (action === "decide") node.querySelector(`[data-approval-decision="${decision}"]`).click();
  if (action === "focus") node.querySelector(`[data-approval-decision="${decision}"]`).focus();
  return { hidden: node.hidden, collapsed: node.querySelector("[data-attention-body]")?.hidden,
    details: node.querySelector("[data-approval-preview]")?.textContent,
    status: node.querySelector('[data-codex-approval] [role="status"]')?.textContent,
    error: node.querySelector('[data-codex-approval] [role="alert"]')?.textContent,
    allowDisabled: node.querySelector('[data-approval-decision="accept"]')?.matches(":disabled"),
    allowHidden: node.querySelector('[data-approval-decision="accept"]')?.hidden,
    html: Boolean(node.querySelector("[data-approval-preview] img, [data-approval-preview] script")),
    ordinary: [...node.querySelectorAll("[data-card-actions] button")].filter(button => !button.hidden && /^(Done|Reopen)$/.test(button.textContent)).length };
}, id, action, decision);
const view = (window, state) => evaluate(window, state => [...document.querySelectorAll('nav[aria-label="Attention views"] button')].find(button => button.textContent.toLowerCase().startsWith(state)).click(), state);
async function screenshot(window, name) {
  window.showInactive(); await sleep(120);
  fs.writeFileSync(path.join(directory, name + ".png"), (await window.webContents.capturePage()).toPNG()); window.hide();
}
async function run() {
  application = await require("../dist/main/index.js").applicationReady;
  const { attention, codexApprovals: approvals, mainWindow: desktop } = application;
  desktop.webContents.setAudioMuted(true);
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async (_device, payload) => { pushes.push(JSON.parse(payload)); }, ["fixture"]);
  await push.initialize(attention.list());
  await push.subscribe("fixture", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/fixture", keys: { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } });
  unsubscribePush = attention.onChanged(snapshot => push.update(snapshot));
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: {
    approval: (source, id) => approvals.get(source, id), approve: (source, id, decision) => approvals.decide(source, id, decision),
    questions: async () => [], message: async () => { throw new Error("Unexpected message"); }, answer: async () => { throw new Error("Unexpected answer"); },
  } });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => {
      if (dropNext && req.method === "POST" && req.url.endsWith("/approvals")) {
        dropNext = false; response.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{"); return;
      }
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 390, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  for (const window of [phone, desktop]) window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  await phone.loadURL(config.origin);
  await wait("phone connected", () => evaluate(phone, () => document.querySelector("#connection").textContent === "Connected to your desktop"));
  await wait("desktop loaded", () => evaluate(desktop, () => Boolean(document.querySelector("[data-attention-inbox]"))));
  assert.equal(await evaluate(phone, () => typeof window.ipcComms), "undefined");
  let sequence = 0;
  async function request(kind = "command", proposal, automaticAck = true) {
    const controller = new AbortController(), wire = []; let ack, fail;
    const responded = new Promise((yes, no) => { ack = yes; fail = no; }); responded.catch(() => {});
    const previous = new Set(attention.list().items.map(item => item.id));
    const method = kind === "file" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const result = approvals.request({ codexPid: 42, codexStartedAt: "2026-10-25T10:00:00Z", vscodePid: 12,
      vscodeStartedAt: "2026-10-25T09:00:00Z", vscodeMainPid: 1, title: "Tray approval fixture", workspace: "D:/fixture" }, method,
      { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "item-" + ++sequence, command: 'echo "café <img src=x onerror=alert(1)>"', cwd: "D:/fixture",
        reason: "Review the fixture before continuing." }, { requestId: sequence, signal: controller.signal, responded }, proposal)
      .then(value => { wire.push(value); if (automaticAck) ack(); return value; }, error => ({ error: error.message }));
    await wait("approval created", () => attention.list().items.some(item => !previous.has(item.id)));
    const id = attention.list().items.find(item => !previous.has(item.id)).id;
    for (const window of [phone, desktop]) { await view(window, "pending"); await wait("shared card", async () => Boolean(await card(window, id))); }
    return { id, wire, result, ack, cancel() { controller.abort(); fail(new Error("Fixture disconnected")); } };
  }
  const command = await request();
  assert((await card(phone, command.id)).collapsed, "Phone approval starts collapsed");
  await push.settled(); assert.equal(pushes.length, 1); assert(pushes[0].url.includes(encodeURIComponent(command.id)));
  await evaluate(phone, url => { location.hash = new URL(url, location.origin).hash; }, pushes[0].url);
  await wait("notification expands approval", async () => (await card(phone, command.id)).collapsed === false);
  await wait("notification reconnect authorized", () => evaluate(phone, () => !document.querySelector("#online-controls").disabled));
  for (const window of [desktop, phone]) {
    await wait("approval controls ready", async () => (await card(window, command.id)).allowDisabled === false);
    const state = await card(window, command.id); assert(state.details.includes('café <img src=x onerror=alert(1)>'));
    assert.equal(state.html, false); assert.equal(state.ordinary, 0); assert.equal(state.allowDisabled, false);
  }
  for (const width of [360, 412]) { phone.setSize(width, 900); await sleep(60); assert(await evaluate(phone, () => document.documentElement.scrollWidth <= innerWidth)); }
  await screenshot(phone, "phone-command"); await screenshot(desktop, "desktop-command");
  await card(phone, command.id, "decide", "accept");
  await wait("phone allowed", () => approvals.get("codex-approval", command.id).status === "allowed");
  await command.result; assert.deepEqual(command.wire, [{ decision: "accept" }]);
  await view(desktop, "done"); await wait("desktop sees phone decision", async () => (await card(desktop, command.id)).status.startsWith("Allowed once."));

  const file = await request("file", { type: "fileChange", changes: [{ path: "src/example.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;" }] });
  await card(phone, file.id, "expand"); assert((await card(phone, file.id)).details.includes("src/example.ts"));
  await screenshot(phone, "phone-file");
  await card(desktop, file.id, "focus", "decline");
  desktop.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  desktop.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  desktop.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await wait("desktop declined", () => approvals.get("codex-approval", file.id).status === "declined");
  assert.deepEqual(file.wire, [{ decision: "decline" }]);
  await view(phone, "done"); await wait("phone sees desktop decision", async () => (await card(phone, file.id)).status.startsWith("Declined."));

  const incomplete = await request("file"); await card(phone, incomplete.id, "expand");
  assert((await card(phone, incomplete.id)).allowDisabled); await card(phone, incomplete.id, "decide", "accept"); assert.equal(incomplete.wire.length, 0);
  await card(phone, incomplete.id, "decide", "decline"); await wait("missing preview still declinable", () => incomplete.wire.length === 1);

  const racing = await request("command", undefined, false); await card(phone, racing.id, "expand");
  await card(desktop, racing.id, "decide", "accept"); await wait("first decision dispatched", () => racing.wire.length === 1);
  const competing = evaluate(phone, async id => {
    const { csrf } = await (await fetch("/api/session")).json();
    return (await fetch(`/api/attention/codex-approval/${id}/approvals`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tray-CSRF": csrf },
      body: JSON.stringify({ requestId: `${Date.now()}-${crypto.randomUUID()}`, value: "decline" }) })).json();
  }, racing.id);
  await sleep(60); racing.ack();
  assert.equal((await competing).result.approval.status, "allowed"); assert.deepEqual(racing.wire, [{ decision: "accept" }]);

  const lost = await request(); await card(phone, lost.id, "expand"); dropNext = true;
  await card(phone, lost.id, "decide", "accept");
  await wait("lost response feedback", async () => (await card(phone, lost.id)).error.includes("Delivery is unconfirmed"));
  await evaluate(phone, () => document.querySelector("#check-delivery").click());
  await wait("receipt recovered", () => evaluate(phone, () => document.querySelector("#delivery").hidden));
  await view(phone, "done"); await wait("recovered status", async () => (await card(phone, lost.id)).status.startsWith("Allowed once."));
  assert.equal(lost.wire.length, 1);

  const expired = await request(); await card(phone, expired.id, "expand");
  await evaluate(phone, () => dispatchEvent(new Event("offline")));
  assert((await card(phone, expired.id)).allowDisabled); await card(phone, expired.id, "decide", "accept"); assert.equal(expired.wire.length, 0);
  expired.cancel(); await wait("expired", () => attention.get("codex-approval", expired.id).approval.status === "expired");
  await evaluate(phone, () => dispatchEvent(new Event("online")));
  await wait("reconnected", () => evaluate(phone, () => !document.querySelector("#online-controls").disabled));
  await view(phone, "done"); await wait("expired visible", async () => (await card(phone, expired.id)).status.startsWith("Request expired."));
  assert((await card(phone, expired.id)).allowHidden); assert.equal(expired.wire.length, 0);
  await evaluate(phone, id => { location.hash = "item=" + encodeURIComponent(JSON.stringify(["codex-approval", id])); }, expired.id);
  await wait("expired deep link remains non-actionable", async () => !(await card(phone, expired.id)).collapsed && (await card(phone, expired.id)).allowHidden);
  assert.equal(errors.filter(message => !/Failed to load resource/.test(message)).length, 0, errors.join("\n"));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["shared desktop IPC and phone HTTP", "push deep link", "collapsed narrow layout", "literal Unicode command", "full file preview", "missing diff disables allow", "phone allow", "desktop keyboard decline", "concurrent conflicting decisions", "lost response receipt without replay", "offline disabled", "expired request and deep link"], directory }, null, 2));
  console.log("PASS Codex phone/desktop approvals:", directory);
}
const watchdog = setTimeout(() => { console.error("Approval smoke timed out"); finish(1); }, 90000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog); phone?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); unsubscribePush?.(); push?.close();
  if (application) { app.once("will-quit", () => app.exit(code)); app.quit(); } else app.exit(code);
}
