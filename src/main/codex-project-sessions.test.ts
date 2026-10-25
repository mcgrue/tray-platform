import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { CodexProjectSessions } from "./codex-project-sessions";
import { CodexInstance } from "../shared/codex-instances";

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tray-project-unit-"));
  const instance: CodexInstance = { codexPid: 42, codexStartedAt: "2026-10-24T10:00:00Z", vscodePid: 12,
    vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 12, workspace: cwd, title: "Project" };
  let callbacks: any;
  const request = jest.fn(async (method: string, params: any): Promise<any> => {
    if (method === "thread/list") return { data: [{ id: "saved", cwd, name: "Saved title", updatedAt: 10 }], nextCursor: null };
    if (method === "thread/start") return { thread: { id: "new-thread" } };
    if (method === "thread/read") return { thread: { id: params.threadId, cwd } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") { callbacks.notification("turn/started", { threadId: params.threadId, turn: { id: "turn" } }); return { turn: { id: "turn" } }; }
    if (method === "turn/steer") return { turnId: "turn" };
  });
  const close = jest.fn();
  const processes = jest.fn(async () => [
    { pid: 42, startedAt: instance.codexStartedAt, parentPid: 12, name: "codex.exe", executablePath: "D:/codex.exe" },
    { pid: 12, startedAt: instance.vscodeStartedAt, parentPid: 0, name: "Code.exe" },
  ]);
  const completed = jest.fn();
  const interaction = jest.fn(async () => ({ decision: "decline" }));
  const createClient = jest.fn((_exe, _cwd, handlers) => { callbacks = handlers; return { request, close }; });
  const service = new CodexProjectSessions({ processes, createClient, completed, interaction });
  return { cwd, instance, service, processes, request, close, completed, createClient, interaction,
    serverRequest: (method: string, params: any, context: any) => callbacks.serverRequest(method, params, context),
    notify: (method: string, params: any) => callbacks.notification(method, params) };
}

test("only complete proposals for the exact thread, turn and item reach the approval callback", async () => {
  const f = await fixture(); await f.service.conversations(f.instance);
  const item = { id: "item", type: "fileChange", changes: [{ path: "source.ts", diff: "-old\n+new" }] };
  const params = { threadId: "thread", turnId: "turn", itemId: "item" };
  const context = { requestId: 1, signal: new AbortController().signal, responded: Promise.resolve() };
  const method = "item/fileChange/requestApproval";
  f.notify("item/started", { ...params, item });
  await f.serverRequest(method, params, context);
  expect(f.interaction).toHaveBeenLastCalledWith(f.instance, method, params, context, item);
  for (const field of ["threadId", "turnId", "itemId"]) {
    const other = { ...params, [field]: "other" }; await f.serverRequest(method, other, context);
    expect(f.interaction).toHaveBeenLastCalledWith(f.instance, method, other, context, undefined);
  }
  f.notify("item/started", { ...params, item: { ...item, changes: [{ path: "source.ts", diff: "x".repeat(180001) }] } });
  await f.serverRequest(method, params, context);
  expect(f.interaction).toHaveBeenLastCalledWith(f.instance, method, params, context, undefined);
  for (const event of ["item/completed", "turn/completed", "thread/closed"]) {
    f.notify("item/started", { ...params, item });
    f.notify(event, { ...params, item, turn: { id: params.turnId, status: "completed" } });
    await f.serverRequest(method, params, context);
    expect(f.interaction).toHaveBeenLastCalledWith(f.instance, method, params, context, undefined);
  }
  f.service.close();
});

test("lists saved project conversations without resuming or starting a turn", async () => {
  const f = await fixture();
  expect(await f.service.conversations(f.instance)).toEqual([{ id: "saved", title: "Saved title", lastActiveAt: 10000 }]);
  expect(f.request.mock.calls.map(call => call[0])).toEqual(["thread/list"]);
  expect(f.request.mock.calls[0][1]).toMatchObject({ cwd: f.cwd, archived: false });
  f.service.close();
});

test("paginates and excludes records from other projects even if the server returns them", async () => {
  const f = await fixture();
  f.request.mockResolvedValueOnce({ data: [{ id: "wrong", cwd: "D:/other", name: "Other" }], nextCursor: "page-2" });
  expect((await f.service.conversations(f.instance)).map(row => row.id)).toEqual(["saved"]);
  expect(f.request.mock.calls[1][1].cursor).toBe("page-2"); f.service.close();
});

test("creates and sends literal input without overriding model, approval or sandbox configuration", async () => {
  const f = await fixture(), text = 'literal\n$(no shell) "quoted" café';
  expect(await f.service.send(f.instance, "", text)).toEqual({ sessionId: "new-thread", turnId: "turn", delivery: "started" });
  expect(f.request.mock.calls).toEqual([["thread/start", { cwd: f.cwd }], ["turn/start", {
    threadId: "new-thread", input: [{ type: "text", text, text_elements: [] }] }]]);
  expect(f.service.owns("new-thread")).toBe(true); f.service.close();
});

test("resumes an explicitly selected saved thread, then steers subsequent input while it is active", async () => {
  const f = await fixture(); await f.service.send(f.instance, "saved", "continue");
  expect(f.request.mock.calls.map(call => call[0])).toEqual(["thread/read", "thread/resume", "turn/start"]);
  expect(await f.service.sendExisting("saved", "correct it")).toMatchObject({ delivery: "steered" });
  expect(f.request.mock.calls[3]).toEqual(["turn/steer", { threadId: "saved", expectedTurnId: "turn", input: [{ type: "text", text: "correct it", text_elements: [] }] }]);
  f.notify("item/agentMessage/delta", { threadId: "saved", delta: "Completed the work." });
  f.notify("turn/completed", { threadId: "saved", turn: { id: "turn", status: "completed" } });
  expect(f.completed).toHaveBeenCalledWith(f.instance, "saved", "turn", "Completed the work.", "completed");
  await f.service.sendExisting("saved", "next task");
  expect(f.request.mock.calls[4][0]).toBe("turn/start"); f.service.close();
});

test("rejects a different project's thread before resume or inference", async () => {
  const f = await fixture(); f.request.mockResolvedValueOnce({ thread: { cwd: "D:/other" } });
  await expect(f.service.send(f.instance, "wrong", "hello")).rejects.toThrow("another project");
  expect(f.request).toHaveBeenCalledTimes(1); f.service.close();
});

test("does not retry uncertain sends and prevents concurrent new-thread creation", async () => {
  const f = await fixture(); let release!: (value: any) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.service.send(f.instance, "", "hello");
  await expect(f.service.send(f.instance, "", "hello")).rejects.toThrow("already being sent");
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  f.request.mockRejectedValueOnce(new Error("Delivery could not be confirmed"));
  release({ thread: { id: "new-thread" } });
  await expect(pending).rejects.toThrow("could not be confirmed");
  expect(f.request.mock.calls.map(call => call[0])).toEqual(["thread/start", "turn/start"]); f.service.close();
});

test("requires exact process identity and closes owned runtimes", async () => {
  const f = await fixture();
  await expect(f.service.conversations({ ...f.instance, codexStartedAt: "2026-10-24T11:00:00Z" })).rejects.toThrow("running local Codex");
  expect(f.createClient).not.toHaveBeenCalled();
  await f.service.conversations(f.instance); f.service.close(); await Promise.resolve();
  expect(f.close).toHaveBeenCalled();
  await expect(f.service.conversations(f.instance)).rejects.toThrow("closed");
});
