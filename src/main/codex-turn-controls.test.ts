import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { CodexTurnSettings, resolveTurnOptions, validateTurnOptions } from "../shared/codex-turn-controls";
import { AttentionItem } from "../shared/attention";
import { CodexProjectSessions } from "./codex-project-sessions";
import { CodexMessageService } from "./codex-message-service";

const catalog: CodexTurnSettings = { available: true, provider: "openai", current: { model: "model-a", effort: "medium" },
  models: [{ id: "model-a", name: "Model A", defaultEffort: "medium", efforts: [
    { id: "medium", description: "Balanced" }, { id: "high", description: "Deeper" }] },
    { id: "model-b", name: "Model B", defaultEffort: "low", efforts: [{ id: "low", description: "Fast" }] }] };

test("validates model, effort, and mode together without changing inherited fields", () => {
  expect(resolveTurnOptions({ mode: "plan", effort: "high" }, catalog)).toEqual({ effort: "high", collaborationMode: {
    mode: "plan", settings: { model: "model-a", reasoning_effort: "high", developer_instructions: null },
  } });
  expect(() => resolveTurnOptions({ model: "model-b" }, catalog)).toThrow("Select a reasoning effort supported");
  expect(resolveTurnOptions({ model: "model-b", effort: "low", mode: "default" }, catalog)).toMatchObject({
    model: "model-b", effort: "low", collaborationMode: { mode: "default", settings: { model: "model-b", reasoning_effort: "low" } },
  });
  expect(() => validateTurnOptions({ model: "model-a", sandboxPolicy: "dangerFullAccess" })).toThrow("Invalid");
});

test("project-owned turns apply selections, persist them, and refuse selected settings while active", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tray-turn-controls-"));
  const instance = { codexPid: 42, codexStartedAt: "2026-11-11T10:00:00Z", vscodePid: 12,
    vscodeStartedAt: "2026-11-11T09:00:00Z", vscodeMainPid: 12, workspace: cwd };
  let notify!: (method: string, params: any) => void;
  const request = jest.fn(async (method: string, params: any): Promise<any> => {
    if (method === "model/list") return { data: catalog.models.map(row => ({ model: row.id, displayName: row.name,
      defaultReasoningEffort: row.defaultEffort, supportedReasoningEfforts: row.efforts.map(effort => ({ reasoningEffort: effort.id })) })), nextCursor: null };
    if (method === "config/read") return { config: { model: "model-a", model_reasoning_effort: "medium", model_provider: "openai" } };
    if (method === "thread/start") return { thread: { id: "new-thread" } };
    if (method === "turn/start") { notify("turn/started", { threadId: params.threadId, turn: { id: "turn" } }); return { turn: { id: "turn" } }; }
  });
  const service = new CodexProjectSessions({ processes: async () => [
    { pid: 42, startedAt: instance.codexStartedAt, parentPid: 12, name: "codex.exe", executablePath: "D:/codex.exe" },
    { pid: 12, startedAt: instance.vscodeStartedAt, parentPid: 0, name: "Code.exe" },
  ], createClient: (_executable, _cwd, callbacks) => { notify = callbacks.notification; return { request, close() {} }; } });
  expect(await service.send(instance, "", "Plan this", { mode: "plan", effort: "high" })).toMatchObject({ delivery: "started" });
  expect(request.mock.calls.find(call => call[0] === "turn/start")![1]).toMatchObject({ collaborationMode: {
    mode: "plan", settings: { model: "model-a", reasoning_effort: "high", developer_instructions: null },
  } });
  expect((await service.turnSettings(instance, "new-thread")).current).toMatchObject({ mode: "plan", model: "model-a", effort: "high" });
  await expect(service.send(instance, "new-thread", "Switch to default", { mode: "default" })).rejects.toThrow("Wait for this turn");
  expect(request.mock.calls.filter(call => call[0] === "turn/start")).toHaveLength(1);
  notify("turn/completed", { threadId: "new-thread", turn: { id: "turn", status: "completed" } });
  await service.send(instance, "new-thread", "Switch to default", { mode: "default" });
  expect(request.mock.calls.filter(call => call[0] === "turn/start")[1][1].collaborationMode.settings.reasoning_effort).toBe("high");
  service.close();
});

const item: AttentionItem = { source: "codex", id: "card", title: "Codex", codexSessionId: "session-a",
  state: "pending", createdAt: 1, updatedAt: 1 };
function ownerFixture(active = false, provider = "openai") {
  const request = jest.fn(async (method: string, params: any, _version: number, owner?: string): Promise<any> => {
    if (method === "thread-owner-discovery") return { method, resultType: "success", handledByClientId: "owner-a" };
    if (method === "thread-follower-read-model-settings") return { method, resultType: "success", handledByClientId: owner,
      result: { settings: { model: "model-a", reasoningEffort: "medium", modelProvider: provider } } };
    if (method === "thread-follower-start-turn" && active) return { method, resultType: "error", error: "active turn already running" };
    return { method, resultType: "success", handledByClientId: owner, result: { result: { turn: { id: "new-turn" } } } };
  });
  const client = { connect: jest.fn(async () => {}), request, close: jest.fn() };
  const service = new CodexMessageService(() => client, undefined, undefined, async () => catalog);
  return { request, service };
}

test("VS Code owner starts a selected new turn without steering or replaying", async () => {
  const f = ownerFixture();
  expect(await f.service.send(item, "Plan this", undefined, { mode: "plan", effort: "high" })).toMatchObject({ delivery: "started" });
  const methods = f.request.mock.calls.map(call => call[0]);
  expect(methods).toEqual(["thread-owner-discovery", "thread-follower-read-model-settings", "thread-follower-start-turn"]);
  expect(f.request.mock.calls[2][1].turnStart.request.collaborationMode).toEqual({ mode: "plan",
    settings: { model: "model-a", reasoning_effort: "high", developer_instructions: null } });
  f.service.close();
});

test("VS Code owner keeps a selected draft when active and rejects a provider mismatch", async () => {
  const active = ownerFixture(true);
  await expect(active.service.send(item, "Plan this", undefined, { mode: "plan" })).rejects.toThrow("Wait for this turn");
  expect(active.request.mock.calls.filter(call => call[0] === "thread-follower-start-turn")).toHaveLength(1);
  active.service.close();
  const mismatched = ownerFixture(false, "other-provider");
  await expect(mismatched.service.send(item, "Plan this", undefined, { mode: "plan" })).rejects.toThrow("different model provider");
  expect(mismatched.request.mock.calls.some(call => call[0] === "thread-follower-start-turn")).toBe(false);
  mismatched.service.close();
});
