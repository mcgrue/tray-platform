import http from "http";
import { Readable } from "stream";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AttentionService } from "../../src/main/attention-service";
import { createAttentionApi } from "../../src/main/attention-api";
import { CodexAttention } from "../../src/main/codex-attention";
const { run } = require("./attention-hook.cjs");

test("hook observation is captured through HTTP, persisted, and preserved on duplicate delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-hook-origin-"));
  const attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  const startedAt = "2026-01-01T00:00:00Z";
  const capture = new CodexAttention({
    listProcesses: async () => [
      { pid: process.pid, parentPid: 2, name: "node.exe", startedAt },
      { pid: 2, parentPid: 1, name: "codex.exe", startedAt },
      { pid: 1, parentPid: 0, name: "Code.exe", startedAt },
    ], areProcessesRunning: async () => true, listWindows: async () => [], activate: async () => {},
  }, { list: () => ({ instances: [], supported: true, scanning: false }), refresh: async () => ({ instances: [], supported: true, scanning: false }) });
  const api = createAttentionApi({ attention, desktop: { listWindows: async () => [] }, prepareInput: (source, input) => capture.prepareInput(source, input) });
  const server = http.createServer((req, res) => { void api(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const event = { hook_event_name: "PreToolUse", tool_name: "request_user_input_async", session_id: "origin-session",
      turn_id: "turn", tool_use_id: "call", cwd: "D:\\project", tool_input: { questions: [{ title: "Choose a setting" }] } };
    const options = { endpoint: "http://127.0.0.1:" + (server.address() as any).port, captureOrigin: true, stateDirectory: directory };
    const send = () => run(Readable.from([JSON.stringify(event)]), options);
    const identity = await send();
    const item = attention.get(identity.source, identity.id)!;
    expect(item.origin).toEqual({ kind: "vscode-codex", codexPid: 2, codexStartedAt: startedAt, vscodePid: 1, vscodeStartedAt: startedAt });
    expect(item).not.toHaveProperty("originProcess");
    await attention.setDestination(identity.source, identity.id, { kind: "url", url: "https://example.com/" });
    await attention.setState(identity.source, identity.id, "done");
    const edited = attention.get(identity.source, identity.id);
    await send();
    expect(attention.get(identity.source, identity.id)).toEqual(edited);
  } finally {
    attention.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
