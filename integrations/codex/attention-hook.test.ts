import http = require("http");
import fs = require("fs");
import os = require("os");
import path = require("path");
import { Readable, PassThrough } from "stream";
import { spawn } from "child_process";
import { AttentionService, validateAttentionInput } from "../../src/main/attention-service";
import { createAttentionApi, MAX_ATTENTION_BODY_BYTES } from "../../src/main/attention-api";
const { toAttention, deliver, run, readInput, MAX_INPUT_BYTES } = require("./attention-hook.cjs");
const { install } = require("./install.cjs");

function event(overrides: any = {}) {
  return {
    hook_event_name: "PreToolUse", tool_name: "request_user_input",
    session_id: "session-a", turn_id: "turn-a", tool_use_id: "call-a",
    cwd: "D:\\dev\\a project",
    tool_input: { questions: [{ id: "choice", question: "Keep café retries?", options: [
      { label: "Keep", description: "Retry later." }, { label: "Reject", description: "Leave available." },
    ] }] },
    ...overrides,
  };
}
const stream = (value: any) => Readable.from([Buffer.from(JSON.stringify(value))]);
const retainedTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-test-"));

let service: AttentionService, server: http.Server, endpoint: string;
let sounds: string[];
beforeEach(async () => {
  sounds = [];
  service = new AttentionService(path.join(retainedTemp(), "attention.json"), { onSound: id => { sounds.push(id); } });
  await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] } });
  server = http.createServer((req, res) => { void api(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as any).port;
});
afterEach(async () => {
  service.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("real HTTP delivery deduplicates concurrent retries, preserves Done, and separates sessions", async () => {
  const input = event();
  await Promise.all(Array.from({ length: 8 }, () => run(stream(input), { endpoint })));
  let items = service.list().items;
  expect(items).toHaveLength(1);
  expect(sounds).toEqual(["icq"]);
  expect(items[0]).toMatchObject({ source: "codex", project: input.cwd, state: "pending" });
  expect(items[0].description).toContain("Keep café retries?");
  expect(items[0].description).toContain("- Keep: Retry later.");
  expect(items[0].description).toContain("Session: session-a");
  await service.upsert("codex", items[0].id, {
    ...items[0], title: "Human title", destination: { kind: "url", url: "https://example.com/chosen" },
  });
  await service.setState("codex", items[0].id, "done");
  const humanEdited = service.get("codex", items[0].id);
  await run(stream(input), { endpoint });
  expect(service.get("codex", items[0].id)).toEqual(humanEdited);
  expect(sounds).toHaveLength(1);
  await run(stream(event({ session_id: "session-b" })), { endpoint });
  items = service.list().items;
  expect(items).toHaveLength(2);
  expect(sounds).toEqual(["icq", "icq"]);
});

test("async questions deliver all titles/options; post-hooks do not resolve or notify", async () => {
  const input = event({ tool_name: "request_user_input_async", tool_input: { questions: [
    { title: "Select the first option", options: ["Alpha", "Beta"] }, { title: "Additional context?" },
  ] } });
  await run(stream(input), { endpoint });
  const item = service.list().items[0];
  expect(item.description).toContain("1. Select the first option\n- Alpha\n- Beta");
  expect(item.description).toContain("2. Additional context?");
  expect(await run(stream({ ...input, hook_event_name: "PostToolUse" }), { endpoint })).toEqual({ ignored: true });
  expect(service.list().items[0].state).toBe("pending");
  expect(sounds).toEqual(["icq"]);
});

test("new turns and calls have new identities; input remains literal text", () => {
  const first = toAttention(event());
  expect(toAttention(event()).id).toBe(first.id);
  expect(toAttention(event({ turn_id: "turn-b" })).id).not.toBe(first.id);
  expect(toAttention(event({ tool_use_id: "call-b" })).id).not.toBe(first.id);
  const dangerousText = '$(Get-Content secret); <script>alert("x")</script>';
  expect(toAttention(event({ tool_input: { questions: [{ question: dangerousText }] } })).body.title).toContain(dangerousText);
});

test("large multibyte questions fit the API limits without losing identifiers", () => {
  const item = toAttention(event({ tool_input: { questions: Array.from({ length: 20 }, () => ({
    question: "界".repeat(4000), options: [{ label: "🙂".repeat(2000), description: "界".repeat(6000) }],
  })) } }));
  expect(() => validateAttentionInput(item.body)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify(item.body))).toBeLessThan(MAX_ATTENTION_BODY_BYTES);
  expect(item.body.description).toContain("Call: call-a");
});

test("unrelated hooks are ignored and malformed identities/questions never send an item", async () => {
  expect(await run(stream(event({ tool_name: "exec_command" })), { endpoint })).toEqual({ ignored: true });
  for (const override of [{ session_id: "" }, { turn_id: undefined }, { tool_use_id: null }, { tool_input: {} }]) {
    await expect(run(stream(event(override)), { endpoint })).rejects.toThrow();
  }
  expect(service.list().items).toHaveLength(0);
});

test("rejects remote targets, credentials, paths, and malformed HTTP success", async () => {
  for (const target of ["https://example.com", "http://192.168.0.2", "http://localhost.evil", "http://user:pass@127.0.0.1", endpoint + "/other"]) {
    expect(() => deliver(toAttention(event()), { endpoint: target })).toThrow();
  }
  server.removeAllListeners("request");
  server.on("request", (_req, res) => { res.writeHead(200); res.end("old sound server"); });
  await expect(run(stream(event()), { endpoint })).rejects.toThrow();
});

test("HTTP deadline bounds an unresponsive server", async () => {
  server.removeAllListeners("request");
  server.on("request", req => req.resume());
  await expect(run(stream(event()), { endpoint, timeoutMs: 40 })).rejects.toThrow("timed out");
});

test("input reader bounds malformed, oversized, and unfinished input", async () => {
  await expect(readInput(Readable.from(["not json"]))).rejects.toThrow("Invalid hook JSON");
  await expect(readInput(Readable.from([Buffer.alloc(MAX_INPUT_BYTES + 1)]))).rejects.toThrow("too large");
  const stalled = new PassThrough();
  await expect(readInput(stalled, 20)).rejects.toThrow("timed out");
  stalled.end();
});

test("CLI exits successfully and emits no policy output when tray delivery fails", async () => {
  server.removeAllListeners("request");
  server.on("request", (req, res) => { req.resume(); res.writeHead(503); res.end(); });
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "attention-hook.cjs")], {
      env: { ...process.env, TRAY_PLATFORM_ATTENTION_URL: endpoint }, windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", data => { out += data; });
    child.stderr.on("data", data => { err += data; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(event()));
  });
  expect(result.code).toBe(0);
  expect(result.out).toBe("");
  expect(result.err).toContain("HTTP 503");
  expect(result.err).not.toContain("café");
});

test("installer preserves existing hooks, creates an exact backup, and is idempotent", () => {
  const codexHome = retainedTemp();
  const original = '{\n "description": "Keep me", "hooks": {"Stop":[{"hooks":[{"type":"command","command":"existing"}]}]}\n}\n';
  const file = path.join(codexHome, "hooks.json");
  fs.writeFileSync(file, original);
  const first = install({ codexHome, nodePath: "C:\\A user's tools\\node.exe" });
  const installed = fs.readFileSync(file, "utf8");
  const hooks = JSON.parse(installed);
  expect(hooks.description).toBe("Keep me");
  expect(hooks.hooks.Stop).toEqual(JSON.parse(original).hooks.Stop);
  expect(fs.readFileSync(first.backups[0], "utf8")).toBe(original);
  expect(hooks.hooks.PreToolUse[0].hooks[0]).toMatchObject({ async: true, timeout: 5 });
  expect(first.commandWindows).toContain("A user''s tools");
  expect(fs.readFileSync(first.bridgePath)).toEqual(fs.readFileSync(path.join(__dirname, "attention-hook.cjs")));
  const second = install({ codexHome, nodePath: "C:\\A user's tools\\node.exe" });
  expect(second.added).toBe(false);
  expect(second.backups).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toBe(installed);
});

test("installer refuses malformed user configuration without replacing it", () => {
  const codexHome = retainedTemp();
  const file = path.join(codexHome, "hooks.json");
  fs.writeFileSync(file, "invalid user content");
  expect(() => install({ codexHome })).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("invalid user content");
  expect(fs.existsSync(path.join(codexHome, "tray-platform"))).toBe(false);
});
