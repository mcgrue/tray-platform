// After yarn pre-build; set CODEX_CLI to the installed extension's codex.exe.
// Isolated Electron UI, private IPC router, deterministic local Codex provider.
// Retains evidence. Does not send to or alter existing Codex conversations.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { createHash } = require("crypto");
const { app } = require("electron");
const { createMessageRuntime } = require("./codex-message-runtime.cjs");
const { loadQuestionContract } = require("./codex-question-extension-contract.cjs");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-questions-"));
const reportPath = path.join(dataPath, "result.json");
app.setName("Tray Codex questions smoke " + process.pid);
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
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the installed extension-bundled codex.exe");
  const contract = loadQuestionContract(path.resolve(process.env.CODEX_CLI, "../../.."));
  runtime = await createMessageRuntime(dataPath, process.env.CODEX_CLI);
  process.env.CODEX_HOME = path.join(dataPath, "codex-home");
  const session = runtime.sessionId, turn = "fixture-turn", call = "fixture-question";
  const questions = [{ title: "Dredmor mine cancellation — test fixture", options: ["Consume before its spell child", "Retain end-of-pass removal"] },
    { title: "Additional implementation notes?" }];
  const identity = call => "question-" + createHash("sha256").update(JSON.stringify([session, turn, call])).digest("hex");
  const id = identity(call);
  const sessions = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "22"); fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, `rollout-2026-10-22T10-00-00-${session}.jsonl`);
  const append = row => fs.appendFileSync(transcript, JSON.stringify(row) + "\n");
  append({ type: "session_meta", payload: { id: session } });
  append({ type: "turn_context", payload: { turn_id: turn } });
  const original = call => append({ type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions }) } });
  original(call);
  const item = call => ({ title: "Codex needs input: Dredmor mine cancellation — test fixture", project: dataPath,
    description: `Project: ${dataPath}\nSession: ${session}\nTurn: ${turn}\nCall: ${call}\nTool: request_user_input_async\n\n1. Truncated display text…` });
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tray-question-smoke-${process.pid}` : path.join(dataPath, "router.sock");
  let mode = "normal", releaseDelivery, deliveryCalls = 0;
  const sent = [];
  const handle = async (socket, message) => {
    if (message.type !== "request") return;
    try {
      let result;
      if (message.method === "initialize") result = { clientId: "smoke-client" };
      else if (message.method === "thread-owner-discovery") {
        assert.equal(message.params.conversationId, session);
        if (mode === "missing") throw new Error("no-client-found");
        result = {};
      } else {
        assert.equal(message.targetClientId, "smoke-owner"); deliveryCalls++;
        if (mode === "delay") await new Promise(resolve => { releaseDelivery = resolve; });
        if (mode === "disconnect") { socket.destroy(); return; }
        result = await runtime.send(message.method, message.params);
        const input = message.params.input || message.params.turnStart.request.input;
        sent.push({ method: message.method, text: input[0].text });
        append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: input[0].text }] } });
      }
      if (socket.writable) socket.write(frame({ type: "response", requestId: message.requestId, method: message.method, handledByClientId: "smoke-owner", resultType: "success", result }));
    } catch (error) { if (socket.writable) socket.write(frame({ type: "response", requestId: message.requestId, resultType: "error", error: error.message })); }
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
  await attention.upsert("codex", id, item(call));
  await attention.upsert("other", "unrelated", { title: "Unrelated pending item" });
  await waitFor("answer composer", () => evaluate(() => !!document.querySelector('[data-codex-question]:not([hidden])')));
  await evaluate(() => { document.querySelector('[data-codex-question]:not([hidden])').open = true; });
  const read = () => evaluate(() => {
    const root = document.querySelector('article:not([hidden]) [data-codex-question]:not([hidden])');
    return root && { values: [...root.querySelectorAll("textarea")].map(input => input.value), disabled: root.querySelector('[data-submit-answer]').disabled,
      error: root.querySelector('[role="alert"]').textContent, status: root.querySelector('[role="status"]').textContent };
  });
  const type = (index, value) => evaluate((index, value) => {
    const input = document.querySelector('article:not([hidden]) [data-codex-question] textarea[data-question-index="' + index + '"]');
    input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
  }, index, value);
  const send = () => evaluate(() => document.querySelector('article:not([hidden]) [data-submit-answer]').click());
  await waitFor("two complete original questions", async () => (await read())?.values.length === 2);
  assert.equal((await read()).disabled, true);
  // A general chat message must not dismiss the question.
  await evaluate(() => {
    const root = document.querySelector('article:not([hidden]) [data-codex-message]'); root.open = true;
    const input = root.querySelector("textarea"); input.value = "General chat, leave the questions open"; input.dispatchEvent(new Event("input")); root.querySelector("button").click();
  });
  await waitFor("ordinary message completed", () => runtime.completed.size === 1);
  assert.equal(attention.get("codex", id).state, "pending");
  assert.equal(contract.pending(call, questions, sent[0].text).length, 2);
  await evaluate(() => document.querySelector('article:not([hidden]) [data-codex-question] fieldset button').click());
  assert.equal((await read()).disabled, true, "every pending question needs an answer");
  const notes = "Keep café 🙂 literal <script> $(text)\nDo not replay cancelled mines.";
  await type(1, notes);
  assert.equal((await read()).disabled, false);
  await attention.upsert("other", "unrelated", { title: "Updated while answering" });
  await sleep(80); assert.equal((await read()).values[1], notes);
  mode = "missing"; await send();
  await waitFor("failed answer retains drafts", async () => (await read()).error.includes("unavailable"));
  assert.equal((await read()).values[1], notes); assert.equal(attention.get("codex", id).state, "pending");
  await evaluate(() => [...document.querySelectorAll('article:not([hidden]) [data-codex-question] button')].find(button => button.textContent === "Reload questions").click());
  await waitFor("reload retains drafts", async () => !(await read()).status.includes("Loading"));
  assert.equal((await read()).values[1], notes);
  await evaluate(() => { document.querySelector('article:not([hidden]) [data-codex-message]').open = false; document.querySelector('article:not([hidden]) [data-codex-question]').scrollIntoView({ block: "start" }); });
  mainWindow.showInactive(); await sleep(150);
  fs.writeFileSync(path.join(dataPath, "answer-composer.png"), (await mainWindow.webContents.capturePage()).toPNG()); mainWindow.hide();
  mode = "normal"; await send();
  await waitFor("answered item Done", () => attention.get("codex", id).state === "done");
  await waitFor("answer reached real runtime", () => runtime.requests.some(request => JSON.stringify(request).includes("send_user_message_question_reply")));
  const idleAnswer = sent.at(-1).text;
  assert.equal(contract.pending(call, questions, idleAnswer).length, 0, "installed extension recognizes all answers");
  assert.equal(contract.pending("other-call", questions, idleAnswer).length, 2, "other questions stay open");
  assert.equal(attention.get("other", "unrelated").state, "pending");
  await waitFor("idle answer turn complete", () => runtime.completed.size === 2);
  // Repeat with an active turn and retain drafts after uncertain delivery.
  const activeCall = "active-question", activeId = identity(activeCall); original(activeCall);
  await attention.upsert("codex", activeId, item(activeCall));
  await evaluate(() => { document.querySelector('article:not([hidden]) [data-codex-question]').open = true; });
  await waitFor("active question loaded", async () => (await read())?.values.length === 2);
  await type(0, "First answer"); await type(1, "Second answer");
  mode = "disconnect"; await send();
  await waitFor("uncertain delivery feedback", async () => (await read()).error.includes("Check the conversation"));
  assert.deepEqual((await read()).values, ["First answer", "Second answer"]);
  assert.equal(attention.get("codex", activeId).state, "pending");
  mode = "normal"; runtime.holdNextResponse();
  await codexMessages.send(attention.get("codex", activeId), "Begin held turn");
  await waitFor("held inference", () => runtime.requests.length >= 3);
  mode = "delay"; await send(); await waitFor("delayed answer", () => !!releaseDelivery);
  assert.equal((await read()).disabled, true);
  const count = deliveryCalls; await send(); await sleep(80); assert.equal(deliveryCalls, count);
  mode = "normal"; releaseDelivery();
  await waitFor("active answer acknowledged", () => attention.get("codex", activeId).state === "done");
  const activeAnswer = sent.at(-1); assert.equal(activeAnswer.method, "thread-follower-steer-turn");
  assert.equal(contract.pending(activeCall, questions, activeAnswer.text, "accepted").length, 0);
  assert.equal(contract.pending(activeCall, questions, activeAnswer.text, "pending").length, 2);
  runtime.releaseResponse();
  await waitFor("steering reaches runtime", () => runtime.requests.some(request => JSON.stringify(request).includes("active-question")));
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, extensionContract: contract.evidence,
    checks: ["legacy original question recovery", "all answers required", "choices and Unicode drafts", "draft retention and reload", "plain chat leaves questions open", "real runtime idle and active answers", "pending versus accepted steering", "installed extension pending-question reducer", "unrelated questions stay pending", "no duplicate submission", "failed and uncertain delivery retain drafts", "Done after acknowledgment"] }, null, 2));
  console.log("Codex question smoke passed:", reportPath);
}
const watchdog = setTimeout(() => { console.error("Question smoke timed out"); app.exit(1); }, 90000);
run().catch(error => { failed = true; console.error(error); fs.writeFileSync(reportPath, JSON.stringify({ passed: false, dataPath, error: error.stack || String(error) }, null, 2)); }).finally(async () => {
  clearTimeout(watchdog); await runtime?.close(); for (const socket of sockets) socket.destroy(); router?.close();
  app.once("will-quit", () => app.exit(failed ? 1 : 0)); app.quit();
});
