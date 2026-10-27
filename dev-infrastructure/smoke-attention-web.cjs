// Real Chromium browser + isolated web backend. No live Codex conversations.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-web-smoke-"));
console.log("PWA smoke evidence:", directory);
app.setPath("userData", path.join(directory, "profile"));
const root = path.join(__dirname, "..");
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "attention-service", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, AttentionService, WebReceipts, WebPushService } = require(path.join(directory, "backend.cjs"));
let web, proxy, window, attention, push;
const sockets = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 20000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
async function run() {
  await app.whenReady();
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  let sent = [], answered = [], failDelivery = false, dropNextMessageResponse = false;
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: {
    message: async (_source, id, text) => { sent.push({ id, text }); if (failDelivery) throw new Error("Fixture disconnected after admission"); return { sessionId: "fixture", turnId: "fixture-turn", delivery: "started" }; },
    questions: async () => [0, 1].map(index => ({ index, title: `Fixture question ${index + 1}`, options: ["Yes", "No"], answered: answered.includes(index) })),
    answer: async (source, id, answers) => { answered.push(...answers.map(answer => answer.index)); if (answered.length === 2) await attention.setState(source, id, "done"); return { sessionId: "fixture", turnId: "fixture-turn", delivery: "started", remainingQuestions: 2 - answered.length }; },
  } });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  const backendPort = web.server.address().port;
  // Fixture-only stand-in for Serve, including identity and original Host.
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => {
        if (dropNextMessageResponse && req.url.endsWith("/messages")) {
          dropNextMessageResponse = false; response.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{"); return;
        }
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  const completion = "completion-" + "a".repeat(64);
  await attention.upsert("codex", completion, { title: "Codex done: PWA fixture", project: "tray-platform", codexSessionId: "fixture", description: "Ready for your next instruction." });
  await attention.upsert("codex", "question-fixture", { title: "Choose fixture behavior", codexSessionId: "fixture",
    description: "Project: fixture\nSession: fixture\nTurn: fixture\nCall: fixture\nTool: request_user_input_async\n\nTwo fixture questions" });
  window = new BrowserWindow({ width: 412, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = []; window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await window.loadURL(config.origin);
  await wait("connected inbox", () => evaluate(() => document.querySelector("#connection").textContent === "Connected to your desktop" && document.querySelectorAll("article").length === 2));
  assert.equal(await evaluate(() => typeof window.ipcComms), "undefined");
  assert.equal(await evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await evaluate(() => [...document.querySelectorAll("article button")].filter(button => button.textContent === "Go").length), 0);
  await wait("questions", () => evaluate(() => document.querySelectorAll('[data-codex-question] fieldset').length === 2));
  const cardState = id => evaluate(id => {
    const card = [...document.querySelectorAll("article")].find(node => node.dataset.attentionKey === JSON.stringify(["codex", id]));
    const body = card.querySelector("[data-attention-body]"), toggle = card.querySelector("[data-attention-disclosure]");
    return { expanded: toggle.getAttribute("aria-expanded") === "true", hidden: body.hidden,
      visible: body.getBoundingClientRect().height > 0, text: card.querySelector('[data-codex-message] [data-message-input]')?.textContent,
      questionDraft: card.querySelector('textarea[data-question-index="1"]')?.value };
  }, id);
  const toggleCard = id => evaluate(id => {
    const card = [...document.querySelectorAll("article")].find(node => node.dataset.attentionKey === JSON.stringify(["codex", id]));
    const toggle = card.querySelector("[data-attention-disclosure]"); toggle.scrollIntoView({ block: "center" }); toggle.click();
  }, id);
  for (const width of [360, 412]) {
    window.setSize(width, 900); await sleep(60);
    assert(await evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll("article")].every(card => card.getBoundingClientRect().height < 100
        && card.querySelector("[data-attention-body]").hidden)), "Inbox cards start with only their title row at phone widths");
  }
  window.showInactive(); await sleep(100);
  fs.writeFileSync(path.join(directory, "phone-collapsed.png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  await toggleCard("question-fixture");
  assert((await cardState("question-fixture")).visible && (await cardState(completion)).hidden, "Each card expands independently");
  await evaluate(() => { const input = document.querySelector('textarea[data-question-index="1"]'); input.value = "Retain my second answer"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await toggleCard("question-fixture"); await toggleCard("question-fixture");
  assert.equal((await cardState("question-fixture")).questionDraft, "Retain my second answer", "Collapse preserves answer drafts");
  await evaluate(() => document.querySelector('[data-codex-question] fieldset button').click());
  await wait("partial answer", () => answered.length === 1); assert.equal(attention.get("codex", "question-fixture").state, "pending");
  assert((await cardState("question-fixture")).expanded, "Answering does not collapse the card");
  await toggleCard(completion);
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('nav[aria-label="Attention views"] button')]
    .map(button => button.textContent.split(" ")[0])), ["Pending", "Done"]);
  assert.equal(await evaluate(() => [...document.querySelectorAll("[data-card-actions] select, [data-card-actions] button")]
    .some(node => node.tagName === "SELECT" || /snooze/i.test(node.textContent))), false);
  assert.equal(await evaluate(() => document.body.textContent.includes("Send to this Codex conversation.")), false);
  const type = text => evaluate(text => { const card = [...document.querySelectorAll("article")].find(card => card.querySelector("h3").textContent.includes("PWA fixture")); const input = card.querySelector("[data-message-input]"); input.textContent = text; input.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await type("A retained mobile draft");
  await toggleCard(completion);
  await evaluate(id => [...document.querySelectorAll("article")].find(node => node.dataset.attentionKey === JSON.stringify(["codex", id])).querySelector("[data-attention-disclosure]").focus(), completion);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await wait("keyboard expansion", async () => (await cardState(completion)).visible);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await wait("keyboard collapse", async () => (await cardState(completion)).hidden);
  assert.equal((await cardState(completion)).text, "A retained mobile draft");
  await toggleCard(completion);
  await evaluate(() => document.querySelector('nav[aria-label="Attention views"] button:nth-child(2)').click());
  await evaluate(() => document.querySelector('nav[aria-label="Attention views"] button:first-child').click());
  await evaluate(() => document.querySelector("#tab-codex-instances").click());
  await evaluate(() => document.querySelector("#tab-attention-inbox").click());
  assert((await cardState(completion)).visible && (await cardState("question-fixture")).visible, "View and section changes retain expansion");
  assert.equal(sent.length, 0, "Collapsing and expanding never sends a draft");
  await attention.upsert("other", "new", { title: "Concurrent desktop update" });
  await wait("SSE update", () => evaluate(() => document.querySelectorAll("article").length === 3));
  assert(await evaluate(() => [...document.querySelectorAll("article")].find(card => card.querySelector("h3").textContent === "Concurrent desktop update")
    .querySelector("[data-attention-body]").hidden), "Incoming items start collapsed");
  assert((await cardState(completion)).visible && (await cardState("question-fixture")).visible, "Live updates preserve expansion");
  assert.equal((await cardState("question-fixture")).questionDraft, "Retain my second answer");
  assert.equal(await evaluate(() => [...document.querySelectorAll("[data-message-input]")].some(input => input.textContent === "A retained mobile draft")), true);
  const send = () => evaluate(() => [...document.querySelectorAll("article")].find(card => card.querySelector("h3").textContent.includes("PWA fixture")).querySelector('[data-codex-message] button[type="submit"]').click());
  await send(); await wait("delivery acknowledged", () => evaluate(() => [...document.querySelectorAll('[data-codex-message] [role="status"]')].some(node => node.textContent.includes("follow-up"))));
  assert.deepEqual(sent, [{ id: completion, text: "A retained mobile draft" }]);
  dropNextMessageResponse = true; await type("Delivered but response lost"); await send();
  await wait("dropped response feedback", () => evaluate(() => [...document.querySelectorAll('[data-codex-message] [role="alert"]')].some(node => node.textContent.includes("Delivery is unconfirmed"))));
  await evaluate(() => document.querySelector("#check-delivery").click());
  await wait("durable success recovered", () => evaluate(() => document.querySelector("#delivery").hidden && ![...document.querySelectorAll("[data-message-input]")].some(input => input.textContent === "Delivered but response lost")));
  assert.equal(sent.length, 2, "Lost acknowledgement reconciles without replay");
  failDelivery = true; await type("Unconfirmed fixture instruction"); await send();
  await wait("unconfirmed feedback", () => evaluate(() => [...document.querySelectorAll('[data-codex-message] [role="alert"]')].some(node => node.textContent.includes("Fixture disconnected"))));
  await send(); await sleep(150); assert.equal(sent.length, 3, "Uncertain delivery is never replayed");
  await evaluate(() => document.querySelector("#check-delivery").click());
  await wait("receipt reconciliation", () => evaluate(() => document.querySelector("#delivery-status").textContent.includes("Still unconfirmed")));
  await wait("service worker ready", () => evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)));
  await toggleCard(completion);
  await attention.setState("codex", completion, "done");
  await evaluate(id => { location.hash = "item=" + encodeURIComponent(JSON.stringify(["codex", id])); }, completion);
  await wait("notification deep link selects Done", () => evaluate(() => document.querySelector('nav[aria-label="Attention views"] button[aria-pressed="true"]').textContent.startsWith("Done")));
  assert((await cardState(completion)).visible, "Notification deep links expand their target card");
  await toggleCard(completion);
  await attention.upsert("codex", completion, { title: "Codex done: Updated PWA fixture", project: "tray-platform", codexSessionId: "fixture", description: "Ready for your next instruction." });
  await wait("later update loaded", () => evaluate(() => [...document.querySelectorAll("article h3")].some(node => node.textContent === "Codex done: Updated PWA fixture")));
  assert((await cardState(completion)).hidden, "Later updates do not reopen a manually collapsed deep-link target");
  await toggleCard(completion);
  window.showInactive(); await sleep(200);
  fs.writeFileSync(path.join(directory, "phone.png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  // Reload under worker control, then simulate network loss. No cached inbox API.
  await window.loadURL(config.origin);
  await wait("worker controls reload", () => evaluate(() => Boolean(navigator.serviceWorker.controller)));
  const proxyClosed = new Promise(resolve => proxy.close(resolve));
  for (const socket of sockets) socket.destroy();
  await proxyClosed;
  await window.loadURL(config.origin).catch(() => {});
  await wait("offline shell", () => evaluate(() => document.body.textContent.includes("Your desktop is unavailable")));
  assert.equal(errors.filter(message => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(message)).length, 0, errors.join("\n"));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, checks: ["browser without Electron bridge", "collapsed phone layout", "keyboard disclosure", "partial question", "collapse and tab draft retention", "SSE expansion retention", "message receipt", "uncertain delivery deduplication", "worker registration", "notification Done deep link expands", "offline shell"], directory }, null, 2));
  console.log("PASS attention PWA browser smoke:", directory);
}
const watchdog = setTimeout(() => { console.error("PWA smoke timed out"); app.exit(1); }, 90000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); window?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); attention?.close(); push?.close(); app.exit(code); }
