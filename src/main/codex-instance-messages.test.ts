import { CodexInstanceMessages } from "./codex-instance-messages";
import { CodexMessageService } from "./codex-message-service";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 42, codexStartedAt: new Date(1000).toISOString(), vscodePid: 12,
  vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 1, title: "Project A", workspace: "D:/A" };
function fixture() {
  const inventory = { list: jest.fn(() => ({ supported: true, scanning: false, instances: [instance] })) };
  const verifyProcesses = jest.fn(async () => true);
  const projects = { conversations: jest.fn(async () => [{ id: "conversation-a", title: "Saved conversation", lastActiveAt: 1200 }]),
    owns: jest.fn(() => false), send: jest.fn(async (_instance, id, _message) => ({ sessionId: id || "created", turnId: "turn", delivery: "started" as const })) };
  let currentOwner = "client-a", delivery = "idle";
  const request = jest.fn(async (method: string, _params: any, _version: number, target?: string): Promise<any> => {
    if (method === "thread-owner-discovery") return { method, resultType: "success", handledByClientId: currentOwner };
    if (method === "thread-follower-steer-turn" && delivery === "idle") return { resultType: "error", error: "Cannot steer conversation conversation-a because its active turn already ended" };
    return { method, resultType: "success", handledByClientId: target,
      result: { result: method === "thread-follower-steer-turn" ? { turnId: "turn" } : { turn: { id: "turn" } } } };
  });
  const client = { connect: jest.fn(async () => {}), request, close: jest.fn() };
  const messages = new CodexMessageService(() => client);
  const service = new CodexInstanceMessages({ inventory, projects, verifyProcesses, messages, createClient: () => client, now: () => 2000 });
  return { service, messages, inventory, projects, verifyProcesses, client,
    moveOwner() { currentOwner = "client-b"; }, working() { delivery = "active"; } };
}

test("lists saved project conversations even when no native conversation is currently loaded", async () => {
  const f = fixture();
  expect(await f.service.conversations(instance)).toEqual([{ id: "conversation-a", title: "Saved conversation", lastActiveAt: 1200 }]);
  expect(f.client.request).not.toHaveBeenCalled();
  expect(f.projects.send).not.toHaveBeenCalled();
  expect(f.verifyProcesses).toHaveBeenCalledWith([{ pid: 42, startedAt: instance.codexStartedAt }, { pid: 12, startedAt: instance.vscodeStartedAt }]);
  f.service.close(); f.messages.close();
});

test.each(["idle", "working"])("sends literal input to the selected open %s conversation", async mode => {
  const f = fixture(); if (mode === "working") f.working();
  await f.service.conversations(instance);
  const text = "Keep café\n<script>literal</script> $(literal)";
  expect(await f.service.send(instance, "conversation-a", text)).toMatchObject({ sessionId: "conversation-a", delivery: mode === "idle" ? "started" : "steered" });
  const steer = f.client.request.mock.calls.find(call => call[0] === "thread-follower-steer-turn")!;
  expect(steer[1].input).toEqual([{ type: "text", text, text_elements: [] }]); expect(steer[3]).toBe("client-a");
  expect(f.projects.send).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
});

test("empty selection creates and sends in the selected project, including when history is empty", async () => {
  const f = fixture(); f.projects.conversations.mockResolvedValue([]);
  await f.service.conversations(instance);
  expect(await f.service.send(instance, "", "what is this branch?")).toMatchObject({ sessionId: "created" });
  expect(f.projects.send).toHaveBeenCalledWith(instance, "", "what is this branch?");
  expect(f.client.request).not.toHaveBeenCalled();
  f.projects.owns.mockReturnValue(true);
  await f.service.send(instance, "created", "follow up");
  expect(f.projects.send).toHaveBeenLastCalledWith(instance, "created", "follow up"); f.service.close(); f.messages.close();
});

test("resumes a saved conversation only after native discovery explicitly reports no owner", async () => {
  const f = fixture(); await f.service.conversations(instance);
  f.client.request.mockResolvedValue({ resultType: "error", error: "no-client-found" });
  await f.service.send(instance, "conversation-a", "continue");
  expect(f.projects.send).toHaveBeenCalledWith(instance, "conversation-a", "continue"); f.service.close(); f.messages.close();
});

test("does not guess a conversation or send an unoffered ID", async () => {
  const f = fixture();
  await expect(f.service.send(instance, "conversation-a", "hello")).rejects.toThrow("Refresh conversations");
  await f.service.conversations(instance);
  await expect(f.service.send(instance, "other", "hello")).rejects.toThrow("Refresh conversations");
  expect(f.client.request).not.toHaveBeenCalled(); expect(f.projects.send).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
});

test("rejects exited, recycled and missing processes before reading or delivering", async () => {
  const f = fixture();
  await expect(f.service.conversations({ ...instance, codexStartedAt: new Date(999).toISOString() })).rejects.toThrow("closed or restarted");
  f.verifyProcesses.mockResolvedValue(false);
  await expect(f.service.send(instance, "", "hello")).rejects.toThrow("closed or restarted");
  expect(f.projects.conversations).not.toHaveBeenCalled(); expect(f.projects.send).not.toHaveBeenCalled();
  f.service.close(); f.messages.close();
});

test("rechecks project membership before sending", async () => {
  const f = fixture(); await f.service.conversations(instance); f.projects.conversations.mockResolvedValue([]);
  await expect(f.service.send(instance, "conversation-a", "hello")).rejects.toThrow("no longer in this project");
  expect(f.client.request).not.toHaveBeenCalled(); expect(f.projects.send).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
});

test("a changed native owner cannot receive the message between discovery and delivery", async () => {
  const f = fixture(); await f.service.conversations(instance);
  f.client.request.mockImplementationOnce(async method => { f.moveOwner(); return { method, resultType: "success", handledByClientId: "client-a" }; });
  await expect(f.service.send(instance, "conversation-a", "hello")).rejects.toThrow("moved to another Codex client");
  expect(f.client.request.mock.calls.every(call => call[0] === "thread-owner-discovery")).toBe(true);
  expect(f.projects.send).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
});

test.each(["client-disconnected", "request-version-mismatch"])("never falls back to another runtime after %s", async reason => {
  const f = fixture(); await f.service.conversations(instance);
  f.client.request.mockResolvedValue({ resultType: "error", error: reason });
  await expect(f.service.send(instance, "conversation-a", "hello")).rejects.toThrow("Could not verify");
  expect(f.projects.send).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
});

test("validates message and instance input, and refuses work after shutdown", async () => {
  const f = fixture();
  for (const text of ["", "  ", null, "x".repeat(20001)]) await expect(f.service.send(instance, "", text)).rejects.toThrow("Enter a message");
  for (const target of [null, {}, { codexPid: -1, codexStartedAt: "bad" }]) await expect(f.service.conversations(target as any)).rejects.toThrow("Invalid Codex instance");
  expect(f.client.request).not.toHaveBeenCalled(); f.service.close(); f.messages.close();
  await expect(f.service.conversations(instance)).rejects.toThrow("closed");
});
