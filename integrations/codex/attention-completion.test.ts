import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { spawn } from "child_process";
import { AttentionService, validateAttentionInput } from "../../src/main/attention-service";
import { createAttentionApi, MAX_ATTENTION_BODY_BYTES } from "../../src/main/attention-api";
const { toAttention, run } = require("./attention-hook.cjs");

const event = (overrides: any = {}) => ({
  hook_event_name: "Stop", session_id: "completion-session", turn_id: "turn-a",
  cwd: "D:\\dev\\tray-platform", stop_hook_active: false,
  last_assistant_message: "Implemented the change. All checks passed.", ...overrides,
});
const stream = (value: any) => Readable.from([JSON.stringify(value)]);
let service: AttentionService, server: http.Server, endpoint: string, directory: string;
let sounds: string[], observations: any[];
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-test-"));
  sounds = []; observations = [];
  service = new AttentionService(path.join(directory, "attention.json"), { onSound: id => { sounds.push(id); } });
  await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] },
    prepareInput: async (_source, input) => { observations.push(input.originProcess); return input; } });
  server = http.createServer((req, res) => { void api(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as any).port;
});
afterEach(async () => {
  service.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("completion is pending attention with the final response and origin, without question state", async () => {
  const stateDirectory = path.join(directory, "question-state");
  const identity = await run(stream(event()), { endpoint, captureOrigin: true, stateDirectory });
  expect(service.get(identity.source, identity.id)).toMatchObject({
    source: "codex", state: "pending", title: "Codex done: tray-platform",
    project: event().cwd, codexSessionId: event().session_id, description: event().last_assistant_message,
  });
  expect(observations).toEqual([{ pid: process.pid, observedAt: expect.any(Number) }]);
  expect(fs.existsSync(stateDirectory)).toBe(false);
  expect(sounds).toEqual(["icq"]);
});

test("concurrent Stop retries preserve human edits and Done; each session and turn is distinct", async () => {
  const options = { endpoint };
  const first = toAttention(event());
  await Promise.all(Array.from({ length: 6 }, () => run(stream(event()), options)));
  expect(service.list().items).toHaveLength(1);
  expect(sounds).toEqual(["icq"]);
  await service.upsert(first.source, first.id, { ...first.body, title: "Reviewed result", sound: undefined });
  await service.setState(first.source, first.id, "done");
  const edited = service.get(first.source, first.id);
  await run(stream(event({ stop_hook_active: true, last_assistant_message: "Changed retry" })), options);
  expect(service.get(first.source, first.id)).toEqual(edited);
  await run(stream(event({ turn_id: "turn-b" })), options);
  await run(stream(event({ session_id: "another-session" })), options);
  expect(service.list().items).toHaveLength(3);
  expect(sounds).toEqual(["icq", "icq", "icq"]);
});

test("completion leaves an unanswered question pending and ignores interruptions and subagent events", async () => {
  const question = { ...event(), hook_event_name: "PreToolUse", tool_name: "request_user_input_async",
    tool_use_id: "call-a", tool_input: { questions: [{ title: "Which project?" }] } };
  const request = await run(stream(question), { endpoint });
  const completed = await run(stream(event()), { endpoint });
  expect(completed.id).not.toBe(request.id);
  for (const hook_event_name of ["SubagentStop", "Interrupt", "SessionEnd", "PostToolUse"]) {
    expect(await run(stream(event({ hook_event_name })), { endpoint })).toEqual({ ignored: true });
  }
  expect(service.list().items).toHaveLength(2);
  expect(service.get(request.source, request.id)?.state).toBe("pending");
});

test("missing messages have a fallback; literal and Unicode output remains within API limits", () => {
  for (const last_assistant_message of [undefined, null, "  "]) {
    expect(toAttention(event({ last_assistant_message })).body.description).toBe("Codex finished this turn.");
  }
  const literal = '$(literal) <script>text</script>\nUnicode: café 🙂';
  expect(toAttention(event({ last_assistant_message: literal })).body.description).toBe(literal);
  const item = toAttention(event({ cwd: "/work/project/", last_assistant_message: "🙂界".repeat(10000) }));
  expect(item.body.title).toBe("Codex done: project");
  expect(() => validateAttentionInput(item.body)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify(item.body))).toBeLessThan(MAX_ATTENTION_BODY_BYTES);
});

test("malformed completion identities and messages never deliver", async () => {
  for (const override of [{ session_id: "" }, { turn_id: undefined }, { cwd: null }, { last_assistant_message: {} }]) {
    await expect(run(stream(event(override)), { endpoint })).rejects.toThrow();
  }
  expect(service.list().items).toHaveLength(0);
});

test("completion CLI cannot block or resume the agent when Tray is unavailable", async () => {
  server.removeAllListeners("request");
  server.on("request", (req, res) => { req.resume(); res.writeHead(503); res.end(); });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "attention-hook.cjs")], {
      env: { ...process.env, TRAY_PLATFORM_ATTENTION_URL: endpoint }, windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event()));
  });
  expect(result).toMatchObject({ code: 0, stdout: "" });
  expect(result.stderr).toContain("HTTP 503");
  expect(result.stderr).not.toContain(event().last_assistant_message);
});
