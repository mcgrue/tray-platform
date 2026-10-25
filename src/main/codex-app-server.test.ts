import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import { CodexAppServer } from "./codex-app-server";

jest.mock("child_process", () => ({ spawn: jest.fn() }));
function fixture(options: ConstructorParameters<typeof CodexAppServer>[2] = {}) {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = jest.fn(() => child.emit("close", 0));
  const requests: any[] = [];
  child.stdin.on("data", (bytes: Buffer) => {
    const value = JSON.parse(bytes.toString()); requests.push(value);
    if (value.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: value.id, result: {} }) + "\n"));
  });
  (spawn as jest.Mock).mockReturnValue(child);
  const client = new CodexAppServer("D:/codex.exe", "D:/project", options);
  return { client, child, requests, async ready() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } };
}

test("uses stdio with no shell, preserves Unicode across fragmented bytes, and routes notifications", async () => {
  const notification = jest.fn(), f = fixture({ notification }); await f.ready();
  const request = f.client.request("thread/list", {}); await f.ready();
  const id = f.requests.find(row => row.method === "thread/list").id;
  const bytes = Buffer.from(JSON.stringify({ id, result: { title: "café" } }) + "\n");
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  f.child.stdout.write(bytes.subarray(0, split)); f.child.stdout.write(bytes.subarray(split));
  expect(await request).toEqual({ title: "café" });
  f.child.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "one" } }) + "\n");
  expect(notification).toHaveBeenCalledWith("turn/completed", { threadId: "one" });
  expect(spawn).toHaveBeenLastCalledWith("D:/codex.exe", ["app-server", "--stdio"], expect.objectContaining({ cwd: "D:/project", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
  f.client.close();
});

test("returns explicit server-request decisions without granting anything automatically", async () => {
  const serverRequest = jest.fn(async () => ({ decision: "decline" }));
  const f = fixture({ serverRequest }); await f.ready();
  f.child.stdout.write(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "test" } }) + "\n");
  await f.ready();
  expect(serverRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", { command: "test" }, expect.objectContaining({ requestId: 99, signal: expect.any(AbortSignal), responded: expect.any(Promise) }));
  expect(f.requests).toContainEqual({ id: 99, result: { decision: "decline" } }); f.client.close();
});

test.each(["serverRequest/resolved", "turn/completed", "thread/closed", "disconnect", "close"])("%s cancels pending approvals without writing a late response", async event => {
  let context: any, answer!: (value: unknown) => void;
  const f = fixture({ serverRequest: (_method, _params, value) => { context = value; return new Promise(resolve => { answer = resolve; }); } });
  await f.ready();
  f.child.stdout.write(JSON.stringify({ id: "approval-99", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item" } }) + "\n");
  if (event === "disconnect") f.child.emit("close", 1);
  else if (event === "close") f.client.close();
  else f.child.stdout.write(JSON.stringify({ method: event, params: { requestId: "approval-99", threadId: "thread", turn: { id: "turn" } } }) + "\n");
  expect(context.signal.aborted).toBe(true); await expect(context.responded).rejects.toThrow();
  answer({ decision: "accept" }); await f.ready();
  expect(f.requests.filter(row => row.id === "approval-99")).toHaveLength(0); f.client.close();
});

test("disconnect rejects delivery, reports failure and never replays", async () => {
  const exited = jest.fn(), f = fixture({ exited }); await f.ready();
  const pending = f.client.request("turn/start", { input: "hello" }); await f.ready();
  f.child.emit("close", 1);
  await expect(pending).rejects.toThrow("could not be confirmed");
  expect(exited).toHaveBeenCalledTimes(1);
  expect(f.requests.filter(row => row.method === "turn/start")).toHaveLength(1);
});

test("a synchronous response write failure rejects acknowledgement without replaying", async () => {
  let context: any, answer!: (value: unknown) => void;
  const f = fixture({ serverRequest: (_method, _params, value) => { context = value; return new Promise(resolve => { answer = resolve; }); } });
  await f.ready();
  f.child.stdout.write(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }) + "\n");
  const write = jest.spyOn(f.child.stdin, "write").mockImplementation(() => { throw new Error("Broken pipe"); });
  answer({ decision: "accept" });
  await expect(context.responded).rejects.toThrow("Broken pipe");
  expect(context.signal.aborted).toBe(true); expect(write).toHaveBeenCalledTimes(1); f.client.close();
});

test("unrelated server resolutions do not cancel another thread's request", async () => {
  let context: any, answer!: (value: unknown) => void;
  const f = fixture({ serverRequest: (_method, _params, value) => { context = value; return new Promise(resolve => { answer = resolve; }); } });
  await f.ready();
  f.child.stdout.write(JSON.stringify({ id: "99", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn" } }) + "\n");
  for (const params of [{ requestId: "99", threadId: "other" }, { requestId: 99, threadId: "thread" }]) {
    f.child.stdout.write(JSON.stringify({ method: "serverRequest/resolved", params }) + "\n");
  }
  expect(context.signal.aborted).toBe(false); answer({ decision: "decline" });
  await context.responded;
  expect(f.requests).toContainEqual({ id: "99", result: { decision: "decline" } }); f.client.close();
});

test("timeout closes the runtime and never replays user input", async () => {
  const f = fixture({ timeoutMs: 20 }); await f.ready();
  await expect(f.client.request("turn/start", { input: "hello" })).rejects.toThrow("did not confirm delivery");
  expect(f.requests.filter(row => row.method === "turn/start")).toHaveLength(1); expect(f.child.kill).toHaveBeenCalled();
});
