// Actual Codex runtime with deterministic local responses; no credentials or inference.
const fs = require("fs"), path = require("path"), http = require("http"), readline = require("readline");
const { spawn } = require("child_process");

async function createMessageRuntime(root, cli) {
  const home = path.join(root, "codex-home"), cwd = path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  let count = 0, holdNext = false, release, activeTurn;
  const requests = [], completed = new Set(), pending = new Map();
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const bytes of req) body += bytes;
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    requests.push(JSON.parse(body));
    if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
    const item = { type: "message", id: "msg_" + ++count, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Received fixture message.", annotations: [] }] };
    const response = { id: "resp_" + count, object: "response", status: "completed", created_at: 1, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[features]', 'hooks = false', 'code_mode = false', '[analytics]', 'enabled = false',
    '[model_providers.fixture]', 'name = "Local message fixture"', 'base_url = "http://127.0.0.1:' + provider.address().port + '/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 30000', "",
  ].join("\n"));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  const child = spawn(cli, ["app-server", "--stdio"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", bytes => fs.appendFileSync(path.join(root, "runtime-stderr.log"), bytes));
  let nextId = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Runtime timeout: " + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  child.on("error", error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    fs.appendFileSync(path.join(root, "runtime-protocol.jsonl"), line + "\n");
    if (message.method === "turn/completed") { completed.add(message.params.turn.id); if (activeTurn === message.params.turn.id) activeTurn = undefined; }
    const entry = !message.method && pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  });
  const close = async () => {
    release?.(); child.stdin.end();
    if (child.exitCode === null) child.kill();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Fixture closed")); } pending.clear();
    provider.closeAllConnections?.(); provider.close();
  };
  try {
    await rpc("initialize", { clientInfo: { name: "tray_message_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const started = await rpc("thread/start", { cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", ephemeral: true, baseInstructions: "Deterministic message fixture." });
    const sessionId = started.thread.id;
    return { sessionId, requests, completed, close,
      holdNextResponse() { holdNext = true; }, releaseResponse() { release?.(); release = undefined; },
      async send(method, params) {
        if (params.conversationId !== sessionId) throw new Error("Wrong conversation");
        if (method === "thread-follower-steer-turn") {
          if (!activeTurn) throw new Error(`Cannot steer conversation ${sessionId} because its active turn already ended`);
          return { result: await rpc("turn/steer", { threadId: sessionId, input: params.input, expectedTurnId: activeTurn }) };
        }
        const result = await rpc("turn/start", { threadId: sessionId, input: params.turnStart.request.input });
        if (!completed.has(result.turn.id)) activeTurn = result.turn.id;
        return { result };
      },
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { createMessageRuntime };
