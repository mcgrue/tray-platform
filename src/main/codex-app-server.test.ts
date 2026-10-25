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
  expect(serverRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", { command: "test" });
  expect(f.requests).toContainEqual({ id: 99, result: { decision: "decline" } }); f.client.close();
});

test("disconnect rejects delivery, reports failure and never replays", async () => {
  const exited = jest.fn(), f = fixture({ exited }); await f.ready();
  const pending = f.client.request("turn/start", { input: "hello" }); await f.ready();
  f.child.emit("close", 1);
  await expect(pending).rejects.toThrow("could not be confirmed");
  expect(exited).toHaveBeenCalledTimes(1);
  expect(f.requests.filter(row => row.method === "turn/start")).toHaveLength(1);
});

test("timeout closes the runtime and never replays user input", async () => {
  const f = fixture({ timeoutMs: 20 }); await f.ready();
  await expect(f.client.request("turn/start", { input: "hello" })).rejects.toThrow("did not confirm delivery");
  expect(f.requests.filter(row => row.method === "turn/start")).toHaveLength(1); expect(f.child.kill).toHaveBeenCalled();
});
