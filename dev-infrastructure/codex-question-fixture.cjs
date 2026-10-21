// Deterministic protocol fixture using an actual Codex app-server, without model inference.
const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { spawn, execFileSync } = require("child_process");
const { install } = require("../integrations/codex/install.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runQuestion({ cli, endpoint, asynchronous = false, answerDuringTurn = false,
  title, onQuestion, onPartialAnswer, onAnswered }) {
  assert(cli, "Set CODEX_CLI to the installed VS Code extension's codex.exe");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-fixture-"));
  const home = path.join(root, "home"), cwd = path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const nodePath = process.versions.electron
    ? execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).trim()
    : process.execPath;
  const installed = install({ codexHome: home, nodePath });
  const tool = asynchronous ? "request_user_input_async" : "request_user_input";
  const toolInput = { questions: [asynchronous
    ? { title, options: ["Alpha", "Beta"] }
    : { id: "probe", header: "Bridge test", question: title, options: [
      { label: "Alpha", description: "Test answer A" }, { label: "Beta", description: "Test answer B" },
    ] }] };
  if (asynchronous) toolInput.questions.push({ title: title + " Follow-up?", options: ["Alpha", "Beta"] });
  const messages = [], pending = new Map();
  let child, nextId = 1, requests = 0;
  const releaseResponses = [];
  const responseGates = [0, 1].map(() => new Promise(resolve => { releaseResponses.push(resolve); }));
  const record = message => fs.appendFileSync(path.join(root, "protocol.jsonl"), JSON.stringify(message) + "\n");
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume the synthetic request. */ }
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    const output = requests++ === 0
      ? [{ type: "function_call", id: "fc_question", call_id: "call_question", name: tool, arguments: JSON.stringify(toolInput) }]
      : [{ type: "message", id: "msg_done", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] }];
    // Release each in-flight response after its reply is steered. Codex runs
    // prompt hooks when it consumes steered input between inference steps.
    if (asynchronous && answerDuringTurn && requests >= 2 && requests <= 3) await responseGates[requests - 2];
    const response = { id: "resp_" + requests, object: "response", status: "completed", created_at: 1, output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } }];
    output.forEach((item, index) => {
      events.push({ type: "response.output_item.added", output_index: index, item });
      events.push({ type: "response.output_item.done", output_index: index, item });
    });
    events.push({ type: "response.completed", response });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map((event, sequence_number) => "event: " + event.type + "\ndata: " +
      JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
  });
  const send = message => { record({ client: message }); child.stdin.write(JSON.stringify(message) + "\n"); };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout: " + method)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error("Codex exited while waiting for " + label);
      await sleep(25);
    }
    throw new Error("Timeout: " + label);
  };
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const configFile = path.join(home, "config.toml");
    fs.writeFileSync(configFile, [
      'model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[features]', 'hooks = true', 'code_mode = false', '[analytics]', 'enabled = false',
      '[model_providers.fixture]', 'name = "Local deterministic fixture"',
      'base_url = "http://127.0.0.1:' + provider.address().port + '/v1"',
      'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0',
      'stream_max_retries = 0', 'stream_idle_timeout_ms = 10000', "",
    ].join("\n"));
    const env = { ...process.env, CODEX_HOME: home, TRAY_PLATFORM_ATTENTION_URL: endpoint };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(cli, ["app-server", "--stdio"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", data => fs.appendFileSync(path.join(root, "stderr.log"), data));
    readline.createInterface({ input: child.stdout }).on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      record({ server: message }); messages.push(message);
      if (!message.method && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      }
    });
    await rpc("initialize", { clientInfo: { name: "tray_codex_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const discovered = await rpc("hooks/list", { cwds: [cwd] });
    const hooks = discovered.data.flatMap(entry => entry.hooks);
    assert.equal(hooks.length, 3);
    for (const hook of hooks) {
      assert.equal(hook.command, process.platform === "win32" ? installed.commandWindows : installed.command);
      assert.equal(path.resolve(hook.sourcePath), path.resolve(installed.hooksPath));
      assert.equal(hook.async, true);
      await rpc("config/value/write", {
        filePath: configFile, keyPath: "hooks.state." + JSON.stringify(hook.key) + ".trusted_hash",
        value: hook.currentHash, mergeStrategy: "upsert",
      });
    }
    const started = await rpc("thread/start", {
      cwd, model: "gpt-6.1-sol", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only",
      ephemeral: true, baseInstructions: "Deterministic notification test.", developerInstructions: "Use the fixture question.",
    });
    const threadId = started.thread.id;
    await rpc("turn/start", { threadId, input: [{ type: "text", text: "Run the bridge test." }],
      collaborationMode: { mode: asynchronous ? "default" : "plan",
        settings: { model: "gpt-6.1-sol", reasoning_effort: "low", developer_instructions: null } } });
    const question = await wait(message => asynchronous
      ? message.method === "item/completed" && message.params.item.delivery === "async"
      : message.method === "item/tool/requestUserInput", "question");
    const event = {
      hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput,
      session_id: started.thread.sessionId || threadId, turn_id: question.params.turnId,
      tool_use_id: asynchronous ? question.params.item.id : question.params.itemId, cwd,
    };
    await onQuestion(event);
    const waitCompleted = async turnId => {
      const completed = await wait(message => message.method === "turn/completed" && message.params.turn.id === turnId, "completion");
      assert.equal(completed.params.turn.status, "completed");
    };
    if (asynchronous) {
      if (!answerDuringTurn) await waitCompleted(event.turn_id);
      for (let index = 0; index < toolInput.questions.length; index++) {
        const prompt = "<send_user_message_question_reply>\n" + JSON.stringify([{
          questionItemId: JSON.stringify([tool, event.tool_use_id, index]),
          question: toolInput.questions[index].title, answer: "Alpha",
        }]) + "\n</send_user_message_question_reply>";
        const result = await rpc(answerDuringTurn ? "turn/steer" : "turn/start", {
          threadId, ...(answerDuringTurn && { expectedTurnId: event.turn_id }), input: [{ type: "text", text: prompt }],
        });
        if (answerDuringTurn) releaseResponses[index]();
        // Background command hooks do not emit hook/completed notifications.
        // Observe durable receipt before asserting that a partial answer stays pending.
        const stateDirectory = path.join(home, "tray-platform", "question-state");
        const deadline = Date.now() + 15000;
        const received = () => fs.existsSync(stateDirectory) && fs.readdirSync(stateDirectory).some(key =>
          fs.readdirSync(path.join(stateDirectory, key)).some(name => name.startsWith("async-answer-" + index + "-")));
        while (!received() && Date.now() < deadline) await sleep(25);
        assert(received(), "Async answer hook must persist receipt");
        if (index < toolInput.questions.length - 1) await onPartialAnswer?.(event);
        else await onAnswered?.(event);
        if (!answerDuringTurn) await waitCompleted(result.turn.id);
      }
      if (answerDuringTurn) await waitCompleted(event.turn_id);
    } else {
      send({ id: question.id, result: { answers: { probe: { answers: ["Alpha"] } } } });
      await waitCompleted(event.turn_id);
      await onAnswered?.(event);
    }
    const result = { event, evidence: root, completed: true, answered: true, answerDuringTurn };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    releaseResponses.forEach(release => release());
    if (child && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(1000)]);
      if (child.exitCode === null) child.kill();
    }
    for (const entry of pending.values()) entry.reject(new Error("Fixture closed"));
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
  }
}
module.exports = { runQuestion };
