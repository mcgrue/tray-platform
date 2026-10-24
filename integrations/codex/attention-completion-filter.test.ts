import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { AttentionService } from "../../src/main/attention-service";
import { createAttentionApi } from "../../src/main/attention-api";
const { run, toAttention } = require("./attention-hook.cjs");

// Runtime probes confirm ephemeral app turns have an explicitly null transcript.
const event = (overrides: any = {}) => ({
  hook_event_name: "Stop", session_id: "background-session", turn_id: "turn-a",
  cwd: "C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\896a0166b774037a",
  transcript_path: null, last_assistant_message: '{"exclude":[]}', ...overrides,
});
const stream = (value: any) => Readable.from([JSON.stringify(value)]);

test("ephemeral completion is ignored before contacting Tray or creating answer state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-filter-test-"));
  const stateDirectory = path.join(directory, "question-state");
  for (const override of [{}, { cwd: "D:\\dev\\project", last_assistant_message: "Finished." }]) {
    const input = event(override);
    expect(toAttention(input)).toBeNull();
    // Invalid endpoint proves a suppressed turn never attempts delivery.
    expect(await run(stream(input), { endpoint: "not-an-endpoint", captureOrigin: true, stateDirectory })).toEqual({ ignored: true });
  }
  expect(fs.existsSync(stateDirectory)).toBe(false);
});

test("only persisted completion notifies; JSON output and a runtime-directory cwd remain valid", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-completion-filter-http-"));
  const sounds: string[] = [];
  const service = new AttentionService(path.join(directory, "attention.json"), { onSound: id => { sounds.push(id); } });
  await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] } });
  const server = http.createServer((req, res) => { void api(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    await run(stream(event()), { endpoint });
    expect(service.list().items).toEqual([]);
    expect(sounds).toEqual([]);
    const persisted = event({ session_id: "user-session", transcript_path: "C:\\codex\\sessions\\user.jsonl" });
    const identity = await run(stream(persisted), { endpoint });
    expect(service.get(identity.source, identity.id)).toMatchObject({ description: '{"exclude":[]}', state: "pending" });
    expect(sounds).toEqual(["icq"]);
    // Existing manual/older producers omit this field entirely.
    const legacy = event({ session_id: "legacy-session" });
    delete legacy.transcript_path;
    await run(stream(legacy), { endpoint });
    expect(service.list().items).toHaveLength(2);
  } finally {
    service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("explicit questions still notify even from an ephemeral session", () => {
  const question = event({ hook_event_name: "PreToolUse", tool_name: "request_user_input_async",
    tool_use_id: "call-a", tool_input: { questions: [{ title: "Choose a project" }] } });
  expect(toAttention(question).body.title).toBe("Choose a project");
});
