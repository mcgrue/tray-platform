// Real installed runtime, isolated config/history and deterministic local inference.
// No credentials, live conversation messages, or project file changes.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-project-runtime-"));
console.log("Project runtime evidence:", root);
const home = path.join(root, "home"), cwd = path.join(root, "project"); fs.mkdirSync(home); fs.mkdirSync(cwd);
const bundle = path.join(root, "project.cjs");
require("esbuild").buildSync({ stdin: { contents: 'export { CodexProjectSessions } from "./src/main/codex-project-sessions"; export { CodexAppServer } from "./src/main/codex-app-server";', resolveDir: process.cwd() },
  outfile: bundle, platform: "node", bundle: true });
const { CodexProjectSessions, CodexAppServer } = require(bundle);
const requests = [], completed = [];
let service, hold, release;
const provider = http.createServer(async (req, res) => {
  let body = ""; for await (const bytes of req) body += bytes;
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
  requests.push(JSON.parse(body));
  if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
  const item = { type: "message", id: "msg_" + requests.length, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Project fixture received the message.", annotations: [] }] };
  const response = { id: "resp_" + requests.length, object: "response", status: "completed", created_at: 1, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.map((event, sequence_number) => "event: " + event.type + "\ndata: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""));
});
async function wait(label, predicate) { const end = Date.now() + 30000; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error("Timeout: " + label); }
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the installed Codex executable");
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), ['model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[features]', 'hooks = false', 'code_mode = false', '[analytics]', 'enabled = false', '[model_providers.fixture]', 'name = "Project fixture"',
    `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0', ""].join("\n"));
  const env = { ...process.env, CODEX_HOME: home }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  const instance = { codexPid: 42, codexStartedAt: "2026-10-24T10:00:00Z", vscodePid: 12, vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 12, workspace: cwd, title: "Fixture" };
  const make = () => new CodexProjectSessions({
    processes: async () => [{ pid: 42, startedAt: instance.codexStartedAt, parentPid: 12, name: "codex.exe", executablePath: process.env.CODEX_CLI },
      { pid: 12, startedAt: instance.vscodeStartedAt, parentPid: 0, name: "Code.exe" }],
    createClient: (exe, folder, callbacks) => new CodexAppServer(exe, folder, { ...callbacks, env }),
    completed: (_instance, sessionId, turnId, text, status) => { completed.push({ sessionId, turnId, text, status }); },
  });
  service = make();
  assert.deepEqual(await service.conversations(instance), []);
  const text = 'What is this branch? Literal café\n$(not a shell)';
  const first = await service.send(instance, "", text);
  assert.equal(first.delivery, "started");
  await wait("first completion", () => completed.length === 1);
  assert.equal(completed[0].status, "completed");
  assert(requests.some(request => JSON.stringify(request).includes(JSON.stringify(text).slice(1, -1))), "Literal first input reaches provider");
  const history = await service.conversations(instance);
  assert(history.some(row => row.id === first.sessionId), "New thread is persisted and selectable");
  service.close(); service = make();
  hold = true;
  const second = await service.send(instance, first.sessionId, "Resume the saved conversation");
  assert.equal(second.sessionId, first.sessionId);
  await wait("held turn", () => release);
  const third = await service.sendExisting(first.sessionId, "Steer the running project task");
  assert.equal(third.delivery, "steered"); release();
  await wait("steering reached provider", () => requests.some(request => JSON.stringify(request).includes("Steer the running project task")));
  await wait("second completion", () => completed.length >= 2);
  assert(completed.every(row => row.status === "completed"));
  assert(completed.every(row => row.text.includes("Project fixture received the message.")), "Completed agent output reaches the inbox callback");
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ first, second, third, completed, providerRequests: requests.length }, null, 2));
  console.log("PASS actual runtime: empty history, new thread, literal message, persisted selection, resume, steering, completion");
}
const watchdog = setTimeout(() => { console.error("Project smoke timed out"); finish(1); }, 90000);
function finish(code) { clearTimeout(watchdog); release?.(); service?.close(); provider.closeAllConnections?.(); provider.close(); process.exitCode = code; }
run().then(() => finish(0), error => { console.error(error); finish(1); });
