// CODEX_CLI=/path/to/codex.exe electron dev-infrastructure/smoke-codex-completion.cjs
// Real runtime, local deterministic responses, isolated profile and retained evidence.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), readline = require("readline");
const { spawn, execFileSync } = require("child_process");
const { Readable } = require("stream");
const { app } = require("electron");
const { install } = require("../integrations/codex/install.cjs");
const { run: runHook, toAttention } = require("../integrations/codex/attention-hook.cjs");
require("./smoke-environment.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-completion-"));
const home = path.join(root, "home"), cwd = path.join(root, "project"), profile = path.join(root, "tray");
fs.mkdirSync(home); fs.mkdirSync(cwd);
app.setName("Tray completion smoke " + process.pid);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: profile, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(30); }
  throw new Error("Timeout: " + label);
}
let child, provider, release, failed = false;
const pending = new Map(), messages = [];
let nextId = 0;
const send = message => child.stdin.write(JSON.stringify(message) + "\n");
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout: " + method)); }, 20000);
  pending.set(id, { resolve, reject, timer }); send({ id, method, params });
});
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to codex.exe");
  const application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow, attention, server } = application;
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  mainWindow.webContents.setAudioMuted(true); mainWindow.hide();
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const sounds = [], originalSend = mainWindow.webContents.send.bind(mainWindow.webContents);
  mainWindow.webContents.send = (channel, ...args) => { if (channel === "play-sound") sounds.push(args[0]); originalSend(channel, ...args); };
  const nodePath = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).trim();
  const installed = install({ codexHome: home, nodePath });
  let requests = 0;
  const finalText = "Completion fixture passed.\nLiteral <script>text</script> and café 🙂.";
  provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume fixture input. */ }
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    requests++;
    if (requests === 1) await new Promise(resolve => { release = resolve; });
    const item = { type: "message", id: "msg_" + requests, role: "assistant", status: "completed", content: [{ type: "output_text", text: finalText, annotations: [] }] };
    const response = { id: "resp_" + requests, object: "response", status: "completed", created_at: 1, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const configFile = path.join(home, "config.toml");
  fs.writeFileSync(configFile, [
    'model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[features]', 'hooks = true', 'code_mode = false', '[analytics]', 'enabled = false',
    '[model_providers.fixture]', 'name = "Local completion fixture"', 'base_url = "http://127.0.0.1:' + provider.address().port + '/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', "",
  ].join("\n"));
  const env = { ...process.env, CODEX_HOME: home, TRAY_PLATFORM_ATTENTION_URL: endpoint };
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  child = spawn(process.env.CODEX_CLI, ["app-server", "--stdio"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", bytes => fs.appendFileSync(path.join(root, "stderr.log"), bytes));
  child.on("error", error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    messages.push(message); fs.appendFileSync(path.join(root, "protocol.jsonl"), line + "\n");
    const entry = !message.method && pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  });
  await rpc("initialize", { clientInfo: { name: "tray_completion_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const hooks = (await rpc("hooks/list", { cwds: [cwd] })).data.flatMap(entry => entry.hooks);
  assert.equal(hooks.length, 4);
  for (const hook of hooks) {
    assert.equal(hook.command, process.platform === "win32" ? installed.commandWindows : installed.command);
    await rpc("config/value/write", { filePath: configFile, keyPath: "hooks.state." + JSON.stringify(hook.key) + ".trusted_hash", value: hook.currentHash, mergeStrategy: "upsert" });
  }
  const started = await rpc("thread/start", { cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", ephemeral: false, baseInstructions: "Deterministic completion fixture." });
  const session = started.thread.sessionId || started.thread.id;
  const startTurn = () => rpc("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Finish this fixture." }] });
  const first = await startTurn();
  await waitFor("inference held", () => !!release);
  assert.equal(attention.list().items.length, 0, "No Done item while the agent is working");
  release();
  const waitCompleted = turn => waitFor("runtime completed", () => messages.some(message => message.method === "turn/completed" && message.params.turn.id === turn && message.params.turn.status === "completed"));
  await waitCompleted(first.turn.id);
  const event = { hook_event_name: "Stop", session_id: session, turn_id: first.turn.id, cwd, last_assistant_message: finalText };
  const expected = toAttention(event);
  await waitFor("Stop hook delivery", () => attention.get("codex", expected.id));
  const item = attention.get("codex", expected.id);
  assert.equal(item.state, "pending"); assert.equal(item.description, finalText); assert.equal(item.codexSessionId, session);
  await waitFor("completion rendered", () => evaluate(title => Array.from(document.querySelectorAll("main article:not([hidden]) h3")).some(node => node.textContent === title), expected.body.title));
  assert.equal(await evaluate(text => document.querySelector("main").textContent.includes(text), finalText), true);
  assert.equal(await evaluate(() => document.querySelectorAll("main script").length), 0);
  assert.equal(mainWindow.isVisible(), true); assert.equal(mainWindow.isFocused(), false);
  await waitFor("one sound", () => sounds.length === 1); assert.deepEqual(sounds, ["icq"]);
  await attention.setState("codex", expected.id, "done");
  const reviewed = attention.get("codex", expected.id);
  await runHook(Readable.from([JSON.stringify(event)]), { endpoint });
  assert.deepEqual(attention.get("codex", expected.id), reviewed); assert.equal(sounds.length, 1);
  const second = await startTurn(); await waitCompleted(second.turn.id);
  await waitFor("second completion item", () => attention.list().items.length === 2);
  assert.equal(attention.list().items.filter(entry => entry.state === "pending").length, 1);
  await waitFor("second sound", () => sounds.length === 2);
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, "attention.json"), "utf8"));
  assert.equal(persisted.items.length, 2);
  assert(persisted.items.some(entry => entry.id === expected.id && entry.state === "done"));
  const screenshot = path.join(root, "inbox.png"); fs.writeFileSync(screenshot, (await mainWindow.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: true, session, turns: [first.turn.id, second.turn.id], screenshot }, null, 2));
  console.log("PASS: real Codex Stop -> installed hook -> HTTP -> rendered inbox; no item during work, final text, one item/sound per turn, retry preserves Done, persistence, no focus steal.");
  console.log(root);
}
const watchdog = setTimeout(() => { console.error("Completion smoke timed out"); app.exit(1); }, 90000);
run().catch(error => { failed = true; console.error(error); }).finally(async () => {
  release?.();
  if (child && child.exitCode === null) {
    child.stdin.end(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(1000)]);
    if (child.exitCode === null) child.kill();
  }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  provider?.closeAllConnections?.(); provider?.close(); clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0)); app.quit();
});
