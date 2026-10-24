// Real desktop/phone question UI and identity checks; delivery is isolated locally.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { createHash } = require("crypto");
const { app, BrowserWindow } = require("electron");
require("./smoke-environment.cjs");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-question-markdown-"));
console.log("Question Markdown evidence:", directory);
app.setName(`Tray question Markdown smoke ${process.pid}`);
app.setPath("userData", directory);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: directory, TRAY_PLATFORM_PORT: "0", CODEX_HOME: path.join(directory, "codex-home"), WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "web-receipts", "web-push-service", "attention-operations", "codex-question-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, WebReceipts, WebPushService, attentionOperations, CodexQuestionService } = require(path.join(directory, "backend.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const session = "markdown-fixture-session", turn = "fixture-turn", call = "fixture-call";
const id = "question-" + createHash("sha256").update(JSON.stringify([session, turn, call])).digest("hex");
const prompt = ["Markdown demo", "", "## Does this render correctly?", "", "**Bold**, *italic*, ~~old~~ and `code`.", "",
  "- First bullet", "- Second bullet", "", "> A blockquote", "", "```ts", "const message = 'hello';", "const longLine = '" + "x".repeat(140) + "';", "```", "",
  "| Feature | Expected |", "| --- | --- |", "| Code | Monospace |", "", "[Review](https://example.com/review)", "",
  "<img src=x onerror=alert(1)>", "[Unsafe](javascript:alert%281%29)"].join("\n");
const questions = [{ title: prompt, options: ["Looks correct", "Needs work"] }, { title: "Any **additional** notes?" }];
const sessions = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "24"); fs.mkdirSync(sessions, { recursive: true });
const transcript = path.join(sessions, `rollout-2026-10-24T00-00-00-${session}.jsonl`);
const append = row => fs.appendFileSync(transcript, JSON.stringify(row) + "\n");
append({ type: "session_meta", payload: { id: session } });
append({ type: "turn_context", payload: { turn_id: turn } });
append({ type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions }) } });
const description = `Project: fixture\nSession: ${session}\nTurn: ${turn}\nCall: ${call}\nTool: request_user_input_async\n\n${prompt}`;
let web, proxy, phone;
const sockets = new Set(), sent = [];
async function run() {
  const { attention, mainWindow: desktop, codexMessages } = await require(path.join(root, "dist/main/index.js")).applicationReady;
  codexMessages.send = async (_item, text) => {
    sent.push(JSON.parse(text.slice(text.indexOf(">") + 1, text.lastIndexOf("<"))));
    append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    return { sessionId: session, turnId: turn, delivery: "started" };
  };
  await attention.upsert("codex", id, { title: ("Codex needs input: " + prompt).slice(0, 500), description });
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  const push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"),
    operations: attentionOperations(attention, codexMessages, new CodexQuestionService(codexMessages)) });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 360, height: 1100, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await phone.loadURL(config.origin);
  for (const [name, window] of [["desktop", desktop], ["phone", phone]]) {
    await wait(name + " questions", () => evaluate(window, () => document.querySelectorAll("[data-codex-question-prompt]").length === 2));
    assert.deepEqual(await evaluate(window, () => {
      const prompt = document.querySelector("[data-codex-question-prompt]"), card = prompt.closest("article");
      return { title: card.querySelector("h3").textContent, heading: prompt.querySelector("h2").textContent,
        bold: prompt.querySelector("strong").textContent, bullets: prompt.querySelectorAll("li").length,
        blocks: Boolean(prompt.querySelector("blockquote") && prompt.querySelector("pre code") && prompt.querySelector("table")),
        unsafe: prompt.querySelectorAll("img,script,[onerror],a[href^='javascript:']").length,
        overflow: document.documentElement.scrollWidth > innerWidth, previewHidden: card.querySelector(":scope > .attention-markdown").hidden };
    }), { title: "Markdown demo", heading: "Does this render correctly?", bold: "Bold", bullets: 2, blocks: true, unsafe: 0, overflow: false, previewHidden: true });
    await evaluate(window, () => { const input = document.querySelector('[data-question-index="1"]'); input.value = "Keep this **literal** draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    window.showInactive(); await sleep(150);
    fs.writeFileSync(path.join(directory, name + ".png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  }
  await attention.upsert("fixture", "unrelated", { title: "Concurrent update" });
  for (const window of [desktop, phone]) {
    await wait("snapshot update", () => evaluate(window, () => document.querySelectorAll("article").length === 2));
    assert.equal(await evaluate(window, () => document.querySelector('[data-question-index="1"]').value), "Keep this **literal** draft");
  }
  await evaluate(phone, () => document.querySelector("[data-codex-question] fieldset button").click());
  await wait("partial answer", () => evaluate(phone, () => !document.querySelector('[data-question-index="0"]')));
  assert.equal(attention.get("codex", id).state, "pending");
  assert.equal(sent[0][0].question, prompt, "Answers retain the exact original Markdown for correlation");
  assert.equal(sent[0][0].answer, "Looks correct");
  assert.equal(await evaluate(phone, () => document.querySelector('[data-question-index="1"]').value), "Keep this **literal** draft");
  assert.equal(await evaluate(phone, () => document.querySelector('[data-codex-question-prompt] strong').textContent), "Bold");
  await evaluate(phone, () => document.querySelector("[data-codex-question]:not([hidden]) [data-submit-answer]").click());
  await wait("all answered", () => attention.get("codex", id).state === "done");
  assert.equal(sent[1][0].question, questions[1].title);
  assert.equal(sent[1][0].answer, "Keep this **literal** draft");
  assert.equal(attention.get("codex", id).description, description);
  console.log("PASS question Markdown, desktop/phone layout, literal answer identity, partial answers and draft retention:", directory);
}
const watchdog = setTimeout(() => { console.error("Question Markdown smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); phone?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); app.exit(code); }
