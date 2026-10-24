// CODEX_CLI=/path/to/codex.exe node dev-infrastructure/smoke-codex-completion-filter.cjs
// Real hooks, local deterministic responses, isolated Codex home; retains evidence.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), readline = require("readline");
const { spawn } = require("child_process");
const { install } = require("../integrations/codex/install.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-filter-"));
const home = path.join(root, "home"), cwd = path.join(root, "project");
fs.mkdirSync(home); fs.mkdirSync(cwd);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), messages = [], deliveries = [];
let child, provider, receiver, nextId = 0;
const send = message => child.stdin.write(JSON.stringify(message) + "\n");
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout: " + method)); }, 20000);
  pending.set(id, { resolve, reject, timer }); send({ id, method, params });
});
async function waitFor(label, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(30); }
  throw new Error("Timeout: " + label);
}
async function main() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to codex.exe");
  receiver = http.createServer(async (req, res) => {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes), parts = req.url.split("/");
    deliveries.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ item: { ...body, source: parts[3], id: parts[4] } }));
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + receiver.address().port;
  const installed = install({ codexHome: home });
  // Record the exact runtime event, then execute the installed CLI unchanged.
  const recorder = path.join(root, "record.cjs");
  fs.writeFileSync(recorder, [
    'const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");',
    'const input = fs.readFileSync(0, "utf8"), event = JSON.parse(input);',
    'const file = path.join(__dirname, event.session_id + ".json");',
    'fs.writeFileSync(file, input);',
    'const result = spawnSync(process.execPath, [' + JSON.stringify(installed.bridgePath) + '], { input, env: process.env, windowsHide: true, timeout: 5000 });',
    'fs.writeFileSync(file + ".result", JSON.stringify({ status: result.status, stderr: result.stderr?.toString() }));',
  ].join("\n"));
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  fs.writeFileSync(installed.hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command",
    command: quote(process.execPath) + " " + quote(recorder),
    command_windows: "& " + quote(process.execPath) + " " + quote(recorder), async: true, timeout: 10,
  }] }] } }));
  let count = 0;
  provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Local fixture only. */ }
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    count++;
    const item = { type: "message", id: "msg_" + count, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: '{"exclude":[]}', annotations: [] }] };
    const response = { id: "resp_" + count, object: "response", status: "completed", created_at: 1,
      output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response }];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const configFile = path.join(home, "config.toml");
  fs.writeFileSync(configFile, [
    'model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[features]', 'hooks = true', 'code_mode = false', '[analytics]', 'enabled = false', '[model_providers.fixture]',
    'name = "Local hook filter fixture"', 'base_url = "http://127.0.0.1:' + provider.address().port + '/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', "",
  ].join("\n"));
  const env = { ...process.env, CODEX_HOME: home, TRAY_PLATFORM_ATTENTION_URL: endpoint };
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  child = spawn(process.env.CODEX_CLI, ["app-server", "--stdio"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", bytes => fs.appendFileSync(path.join(root, "stderr.log"), bytes));
  child.on("error", error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    messages.push(message);
    const entry = !message.method && pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  });
  await rpc("initialize", { clientInfo: { name: "tray_completion_filter_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const hooks = (await rpc("hooks/list", { cwds: [cwd] })).data.flatMap(entry => entry.hooks);
  assert.equal(hooks.length, 1);
  await rpc("config/value/write", { filePath: configFile, keyPath: "hooks.state." + JSON.stringify(hooks[0].key) + ".trusted_hash", value: hooks[0].currentHash, mergeStrategy: "upsert" });
  const observations = [];
  for (const ephemeral of [true, false]) {
    const started = await rpc("thread/start", { cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", ephemeral,
      baseInstructions: "Deterministic completion filter fixture." });
    const session = started.thread.sessionId || started.thread.id;
    const turn = await rpc("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Return the fixture JSON." }] });
    await waitFor("turn completed", () => messages.some(message => message.method === "turn/completed" && message.params.turn.id === turn.turn.id));
    const eventFile = path.join(root, session + ".json");
    await waitFor("hook finished", () => fs.existsSync(eventFile + ".result"));
    const event = JSON.parse(fs.readFileSync(eventFile, "utf8")), result = JSON.parse(fs.readFileSync(eventFile + ".result", "utf8"));
    assert.deepEqual(result, { status: 0, stderr: "" });
    observations.push({ ephemeral, event, deliveryCount: deliveries.length });
    console.log(JSON.stringify(observations[observations.length - 1]));
  }
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ observations, deliveries }, null, 2));
  assert.equal(observations[0].deliveryCount, 0, "Ephemeral background completion must be silent");
  assert.equal(observations[1].deliveryCount, 1, "Persisted user session must still notify for identical JSON output");
  assert.equal(deliveries[0].description, '{"exclude":[]}');
  console.log("PASS: installed hook suppresses ephemeral turns and preserves persisted session completion.");
}
const watchdog = setTimeout(() => { console.error("Completion filter smoke timed out"); process.exit(1); }, 90000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) {
    child.stdin.end(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(1000)]);
    if (child.exitCode === null) child.kill();
  }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  provider?.closeAllConnections?.(); provider?.close(); receiver?.closeAllConnections?.(); receiver?.close();
  clearTimeout(watchdog); console.log(root);
});
