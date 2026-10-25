// Installed Codex runtime, isolated history/config, deterministic localhost provider.
// Only a harmless fixture command and temporary source files; no credentials or live conversations.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-approval-runtime-"));
console.log("Approval runtime evidence:", directory);
const home = path.join(directory, "home"), cwd = path.join(directory, "project"); fs.mkdirSync(home); fs.mkdirSync(cwd);
require("esbuild").buildSync({ stdin: { contents: ["codex-project-sessions", "codex-app-server", "codex-approval-service", "attention-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: process.cwd() },
  outfile: path.join(directory, "runtime.cjs"), platform: "node", bundle: true });
const { CodexProjectSessions, CodexAppServer, CodexApprovalService, AttentionService } = require(path.join(directory, "runtime.cjs"));
let projects, approvals, attention, toolSent = false, counter = 0, activeCase;
const events = [], interactions = [], completed = [], providerInputs = [];
const provider = http.createServer(async (req, res) => {
  let body = ""; for await (const bytes of req) body += bytes;
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
  const input = JSON.parse(body); providerInputs.push({ url: req.url, ...input });
  fs.writeFileSync(path.join(directory, "provider-inputs.json"), JSON.stringify(providerInputs, null, 2));
  let item;
  if (!toolSent) {
    toolSent = true;
    const tools = input.tools || input.input.filter(item => item.type === "additional_tools").flatMap(item => item.tools);
    const code = tools.find(tool => tool.type === "namespace" && tool.name === "functions")?.tools?.some(tool => tool.name === "exec");
    const name = tools.find(tool => ["exec_command", "shell_command"].includes(tool.name))?.name;
    if (!code && !name) { console.error("No shell tool:", tools.map(tool => tool.name)); res.writeHead(500); res.end(); return; }
    const args = { [name === "shell_command" ? "command" : "cmd"]: "Write-Output 'TRAY_APPROVAL_FIXTURE'", sandbox_permissions: "require_escalated", justification: "Allow the isolated Tray approval fixture?" };
    const file = activeCase.startsWith("file-"), patch = `*** Begin Patch\n*** Add File: ${path.join(cwd, activeCase + ".ts").replace(/\\/g, "/")}\n+export const approvalFixture = true;\n*** End Patch`;
    item = code ? { type: "custom_tool_call", id: "fc_" + ++counter, call_id: "call_" + counter, namespace: "functions", name: "exec",
      input: file ? `text(await tools.apply_patch(${JSON.stringify(patch)}));` : `text(await tools.exec_command(${JSON.stringify(args)}));`, status: "completed" }
      : file ? { type: "custom_tool_call", id: "fc_" + ++counter, call_id: "call_" + counter, name: "apply_patch", input: patch, status: "completed" }
      : { type: "function_call", id: "fc_" + ++counter, call_id: "call_" + counter, name, arguments: JSON.stringify(args), status: "completed" };
  } else item = { type: "message", id: "msg_" + ++counter, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Approval fixture finished.", annotations: [] }] };
  const response = { id: "resp_" + counter, object: "response", status: "completed", created_at: 1, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const stream = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(stream.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
});
async function wait(label, predicate) { const end = Date.now() + 25000; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error("Timeout: " + label); }
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the installed Codex executable");
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), ['model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
    '[features]', 'hooks = false', 'code_mode = false', '[analytics]', 'enabled = false', '[model_providers.fixture]', 'name = "Approval fixture"',
    `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', ""].join("\n"));
  const env = { ...process.env, CODEX_HOME: home }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  approvals = new CodexApprovalService(attention); await approvals.initialize();
  const instance = { codexPid: 42, codexStartedAt: "2026-10-25T10:00:00Z", vscodePid: 12, vscodeStartedAt: "2026-10-25T09:00:00Z", vscodeMainPid: 12, workspace: cwd, title: "Fixture" };
  projects = new CodexProjectSessions({ processes: async () => [
    { pid: 42, startedAt: instance.codexStartedAt, parentPid: 12, name: "codex.exe", executablePath: process.env.CODEX_CLI },
    { pid: 12, startedAt: instance.vscodeStartedAt, parentPid: 0, name: "Code.exe" }],
    createClient: (exe, folder, callbacks) => new CodexAppServer(exe, folder, { ...callbacks, env,
      notification: (method, params) => { events.push({ method, params, testCase: activeCase }); callbacks.notification(method, params); } }),
    interaction: async (...args) => { interactions.push({ method: args[1], params: args[2], proposed: args[4], testCase: activeCase }); return approvals.request(...args); },
    completed: (_instance, sessionId, turnId, text, status) => completed.push({ sessionId, turnId, text, status, testCase: activeCase }),
  });
  for (const [kind, decision] of [["command", "accept"], ["command", "decline"], ["file", "accept"], ["file", "decline"]]) {
    activeCase = kind + "-" + decision; toolSent = false;
    const result = await projects.send(instance, "", "Run the isolated harmless approval fixture once.");
    await wait("runtime approval " + decision, () => attention.list().items.some(item => item.approval?.threadId === result.sessionId));
    const item = attention.list().items.find(item => item.approval?.threadId === result.sessionId);
    assert.equal(item.approval.status, "pending"); assert.equal(item.approval.canAllow, true);
    assert(item.approval.details.includes(kind === "file" ? "export const approvalFixture = true;" : "TRAY_APPROVAL_FIXTURE"));
    assert(!completed.some(row => row.sessionId === result.sessionId), "Turn waits for a human decision");
    const receipt = await approvals.decide(item.source, item.id, decision);
    assert.equal(receipt.approval.status, decision === "accept" ? "allowed" : "declined");
    await wait("completion " + decision, () => completed.some(row => row.sessionId === result.sessionId));
    const finished = events.filter(event => event.testCase === activeCase && event.method === "item/completed" && event.params.item.type === (kind === "file" ? "fileChange" : "commandExecution"));
    assert.equal(finished.length, 1); assert.equal(finished[0].params.item.status, decision === "accept" ? "completed" : "declined");
    if (kind === "file") {
      const target = path.join(cwd, activeCase + ".ts"); assert.equal(fs.existsSync(target), decision === "accept");
      if (decision === "accept") assert(fs.readFileSync(target, "utf8").includes("export const approvalFixture = true;"));
    } else if (decision === "accept") assert(finished[0].params.item.aggregatedOutput.includes("TRAY_APPROVAL_FIXTURE"));
    else assert(!finished[0].params.item.aggregatedOutput?.includes("TRAY_APPROVAL_FIXTURE"));
  }
  assert.equal(interactions.length, 4);
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, interactions, completed, events }, null, 2));
  console.log("PASS installed runtime: command/file approval requests, exact previews, wait, allow, decline, completed item status");
}
const watchdog = setTimeout(() => { console.error("Approval runtime smoke timed out"); finish(1); }, 90000);
function finish(code) {
  clearTimeout(watchdog); fs.writeFileSync(path.join(directory, "diagnostics.json"), JSON.stringify({ interactions, completed, events, providerInputs }, null, 2));
  projects?.close(); approvals?.close(); attention?.close(); provider.closeAllConnections?.(); provider.close(); process.exitCode = code;
}
run().then(() => finish(0), error => { console.error(error); finish(1); });
