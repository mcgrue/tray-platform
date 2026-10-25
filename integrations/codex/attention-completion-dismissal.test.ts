import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { Readable } from "stream";
import { AttentionService } from "../../src/main/attention-service";
import { createAttentionApi } from "../../src/main/attention-api";
const { run, toAttention } = require("./attention-hook.cjs");
const { install } = require("./install.cjs");

const stop = (overrides: any = {}) => ({ hook_event_name: "Stop", session_id: "session-a", turn_id: "turn-a",
  cwd: "D:\\project", transcript_path: "saved.jsonl", last_assistant_message: "Result", ...overrides });
const prompt = (overrides: any = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "session-a",
  turn_id: "turn-b", prompt: "Please continue", ...overrides });
const stream = (event: any) => Readable.from([JSON.stringify(event)]);
const question = { ...stop(), hook_event_name: "PreToolUse", tool_name: "request_user_input_async",
  tool_use_id: "call-a", tool_input: { questions: [{ title: "Which option?" }] } };
let directory: string, service: AttentionService, server: http.Server, options: any;
let sounds: string[], requests: string[], failList: boolean, failState: boolean;
let prepare: (input: any) => Promise<any>;
const invoke = (event: any) => run(stream(event), options);
const item = (event: any) => { const identity = toAttention(event); return service.get(identity.source, identity.id)!; };

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-dismissal-"));
  sounds = []; requests = []; failList = false; failState = false;
  prepare = async input => input;
  service = new AttentionService(path.join(directory, "attention.json"), { onSound: id => { sounds.push(id); } });
  await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] }, prepareInput: (_source, input) => prepare(input) });
  server = http.createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    if ((failList && req.method === "GET") || (failState && req.method === "POST")) {
      req.resume(); res.writeHead(503); res.end();
    } else void api(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  options = { endpoint: "http://127.0.0.1:" + (server.address() as any).port,
    stateDirectory: path.join(directory, "question-state"), completionStateDirectory: path.join(directory, "completion-state") };
});
afterEach(async () => {
  service.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("a message acknowledges only earlier completions in its exact session, retaining edits and history", async () => {
  const older = stop({ turn_id: "older" }), other = stop({ session_id: "session-b" }), current = stop({ turn_id: "turn-b" });
  for (const event of [stop(), older, other, current, question]) await invoke(event);
  const identity = toAttention(stop());
  await service.upsert("codex", identity.id, { ...identity.body, title: "Human title", destination: { kind: "url", url: "https://example.com" } });
  await service.upsert("manual", identity.id, { ...identity.body });
  const before = item(stop());
  await invoke(prompt());
  expect(item(stop())).toMatchObject({ state: "done", title: before.title, destination: before.destination, createdAt: before.createdAt });
  expect(item(older).state).toBe("done");
  for (const event of [other, current, question]) expect(item(event).state).toBe("pending");
  expect(service.get("manual", identity.id)?.state).toBe("pending");
  expect(sounds).toHaveLength(6);
  expect(JSON.parse(fs.readFileSync(path.join(directory, "attention.json"), "utf8")).items).toHaveLength(6);
});

test("pre-upgrade completions are acknowledged using inbox session metadata", async () => {
  const old = toAttention(stop());
  await service.upsert(old.source, old.id, old.body);
  expect(fs.existsSync(options.completionStateDirectory)).toBe(false);
  await invoke(prompt());
  expect(item(stop()).state).toBe("done");
});

test("duplicate prompts and Stops preserve manual reopens and newer results", async () => {
  await invoke(stop()); await invoke(prompt());
  await service.setState("codex", toAttention(stop()).id, "pending");
  const reopened = item(stop());
  const later = stop({ turn_id: "turn-c" });
  await invoke(later);
  await invoke(prompt()); await invoke(stop());
  expect(item(stop())).toEqual(reopened);
  expect(item(later).state).toBe("pending");
  await invoke(prompt({ turn_id: "turn-d", prompt: "Next request" }));
  expect(item(later).state).toBe("done");
  expect(item(stop())).toEqual(reopened);
});

test("a prompt racing an in-flight completion marks it done after its PUT completes", async () => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  prepare = async input => { entered(); await gate; return input; };
  const delivery = invoke(stop());
  await waiting;
  try { await invoke(prompt()); } finally { release(); }
  await delivery;
  expect(item(stop()).state).toBe("done");
});

test("failed creation acknowledged before a retry stays silent and lands in Done", async () => {
  prepare = async () => { throw new Error("temporary failure"); };
  await expect(invoke(stop())).rejects.toThrow("500");
  await invoke(prompt());
  prepare = async input => input;
  await invoke(stop());
  expect(item(stop()).state).toBe("done");
  expect(sounds).toEqual([]);
});

test("failed dismissal retries its original targets without swallowing a newer completion", async () => {
  await invoke(stop()); failState = true;
  await expect(invoke(prompt())).rejects.toThrow("503");
  const later = stop({ turn_id: "turn-c" }); await invoke(later);
  failState = false; await invoke(prompt());
  expect(item(stop()).state).toBe("done");
  expect(item(later).state).toBe("pending");
});

test("a failed snapshot keeps its original time cutoff on retry", async () => {
  await invoke(stop()); failList = true;
  await expect(invoke(prompt())).rejects.toThrow("503");
  await new Promise(resolve => setTimeout(resolve, 15));
  const later = stop({ turn_id: "turn-c" }); await invoke(later);
  failList = false; await invoke(prompt());
  expect(item(stop()).state).toBe("done");
  expect(item(later).state).toBe("pending");
});

test("completion-list failure does not prevent a structured question answer from resolving", async () => {
  await invoke(question); await invoke(stop()); failList = true;
  const reply = "<send_user_message_question_reply>" + JSON.stringify([{ questionItemId: JSON.stringify([question.tool_name, question.tool_use_id, 0]),
    question: question.tool_input.questions[0].title, answer: "Chosen" }]) + "</send_user_message_question_reply>";
  await expect(invoke(prompt({ prompt: reply }))).rejects.toThrow("503");
  expect(item(question).state).toBe("done");
  expect(item(stop()).state).toBe("pending");
});

test("empty or malformed prompts and non-prompt events do not acknowledge completions", async () => {
  await invoke(stop());
  const count = requests.length;
  for (const override of [{ prompt: "" }, { prompt: " " }, { prompt: null }, { session_id: "" }, { turn_id: undefined },
    { hook_event_name: "PostToolUse" }, { hook_event_name: "SessionEnd" }]) await invoke(prompt(override));
  expect(item(stop()).state).toBe("pending");
  expect(requests).toHaveLength(count);
});

test("same-turn and concurrently delivered completions survive a slow snapshot", async () => {
  await invoke(stop());
  server.removeAllListeners("request");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] } });
  server.on("request", async (req, res) => { if (req.method === "GET") { entered(); await gate; } await api(req, res); });
  const submission = invoke(prompt()); await waiting;
  await new Promise(resolve => setTimeout(resolve, 15));
  const current = stop({ turn_id: "turn-b" }), future = stop({ turn_id: "turn-c" });
  try { await invoke(current); await invoke(future); } finally { release(); }
  await submission;
  expect(item(stop()).state).toBe("done");
  expect(item(current).state).toBe("pending");
  expect(item(future).state).toBe("pending");
});

async function cli(event: any, bridgePath: string, home: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], { windowsHide: true,
      env: { ...process.env, CODEX_HOME: home, TRAY_PLATFORM_ATTENTION_URL: options.endpoint } });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

test("installed hooks share durable acknowledgement state across processes and retain no prompt text", async () => {
  const home = path.join(directory, "home"), installed = install({ codexHome: home });
  const originalHooks = fs.readFileSync(installed.hooksPath);
  expect(await cli(stop(), installed.bridgePath, home)).toEqual({ code: 0, stdout: "", stderr: "" });
  const submission = prompt({ prompt: "Private message that must not be retained" });
  expect(await cli(submission, installed.bridgePath, home)).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(item(stop()).state).toBe("done");
  await service.setState("codex", toAttention(stop()).id, "pending");
  const reopened = item(stop());
  await cli(submission, installed.bridgePath, home); await cli(stop(), installed.bridgePath, home);
  expect(item(stop())).toEqual(reopened);
  const stateRoot = path.join(home, "tray-platform", "completion-state");
  const contents = fs.readdirSync(stateRoot).flatMap(folder => fs.readdirSync(path.join(stateRoot, folder))
    .map(file => fs.readFileSync(path.join(stateRoot, folder, file), "utf8"))).join("\n");
  expect(contents).not.toContain(submission.prompt);
  expect(contents).not.toContain(stop().last_assistant_message);
  expect(install({ codexHome: home }).addedEvents).toEqual([]);
  expect(fs.readFileSync(installed.hooksPath)).toEqual(originalHooks);
});

test("installed prompt hook fails open without logging message text when Tray is unavailable", async () => {
  const home = path.join(directory, "home"), installed = install({ codexHome: home });
  failList = true;
  const result = await cli(prompt({ prompt: "Private user text" }), installed.bridgePath, home);
  expect(result).toMatchObject({ code: 0, stdout: "" });
  expect(result.stderr).toContain("503");
  expect(result.stderr).not.toContain("Private user text");
});
