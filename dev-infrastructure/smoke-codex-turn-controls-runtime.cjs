// Installed Codex app-server with a local response fixture; no live conversation or inference.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { createMessageRuntime } = require("./codex-message-runtime.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-turn-runtime-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (predicate()) return; await sleep(40); } throw Error("Timeout: " + label); }
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the installed codex.exe");
  const runtime = await createMessageRuntime(directory, process.env.CODEX_CLI);
  try {
    const input = text => [{ type: "text", text }];
    const first = await runtime.rpc("turn/start", { threadId: runtime.sessionId, input: input("Fixture plan turn"),
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } } });
    await wait("selected turn completed", () => runtime.completed.has(first.turn.id));
    assert.equal(runtime.requests[0].model, "gpt-6.1-sol");
    assert.equal(runtime.requests[0].reasoning?.effort, "high");
    const second = await runtime.rpc("turn/start", { threadId: runtime.sessionId, input: input("Fixture inherited turn") });
    await wait("inherited turn completed", () => runtime.completed.has(second.turn.id));
    assert.equal(runtime.requests[1].model, "gpt-6.1-sol");
    assert.equal(runtime.requests[1].reasoning?.effort, "high");
    console.log("PASS installed Codex turn controls runtime:", directory);
  } finally { await runtime.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
