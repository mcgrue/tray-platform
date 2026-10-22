import * as net from "net";
import { randomUUID } from "crypto";
import { CodexIpcClient } from "./codex-ipc";

function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
let server: net.Server, endpoint: string, sockets: Set<net.Socket>;
let handle: (socket: net.Socket, message: any) => void;
beforeEach(async () => {
  endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tray-codex-test-${randomUUID()}` : `/tmp/tray-codex-${randomUUID()}.sock`;
  sockets = new Set();
  handle = (socket, message) => socket.write(frame({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, result: { clientId: "test-client" } }));
  server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4); handle(socket, message);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("decodes split UTF-8 frames, ignores broadcasts and declines ownership requests", async () => {
  const client = new CodexIpcClient(endpoint, 1000); await client.connect();
  const messages: any[] = [];
  handle = (socket, message) => {
    messages.push(message);
    if (message.type !== "request") return;
    expect(message.sourceClientId).toBe("test-client");
    const bytes = Buffer.concat([
      frame({ type: "broadcast", params: "unrelated" }),
      frame({ type: "client-discovery-request", requestId: "discovery" }),
      frame({ type: "response", requestId: message.requestId, method: message.method, resultType: "success", result: { text: "café 🙂" } }),
    ]);
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => { socket.write(bytes.subarray(2, bytes.length - 4)); setImmediate(() => socket.write(bytes.subarray(bytes.length - 4))); });
  };
  expect((await client.request("probe", {}, 1, "owner-a")).result).toEqual({ text: "café 🙂" });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(messages).toContainEqual({ type: "client-discovery-response", requestId: "discovery", response: { canHandle: false } });
  expect(messages[0]).toMatchObject({ method: "probe", version: 1, targetClientId: "owner-a" });
  client.close();
});

test("deadline rejects missing acknowledgement and never reconnects or resends", async () => {
  const client = new CodexIpcClient(endpoint, 40); await client.connect();
  let sends = 0; handle = () => { sends++; };
  await expect(client.request("send", {}, 1)).rejects.toThrow("Check the conversation");
  await expect(client.request("send", {}, 1)).rejects.toThrow("not connected");
  expect(sends).toBe(1); client.close();
});

test.each(["length", "json", "response", "disconnect"])("closes on invalid delivery acknowledgement: %s", async failure => {
  const client = new CodexIpcClient(endpoint, 1000); await client.connect();
  handle = (socket, request) => {
    if (failure === "disconnect") { socket.destroy(); return; }
    if (failure === "length") { const header = Buffer.alloc(4); header.writeUInt32LE(100 * 1024 * 1024); socket.write(header); return; }
    if (failure === "json") { socket.write(Buffer.from([1, 0, 0, 0, 123])); return; }
    socket.write(frame({ type: "response", requestId: request.requestId, resultType: "maybe" }));
  };
  await expect(client.request("send", {}, 1)).rejects.toThrow(/Check the conversation/);
  client.close();
});

test("shutdown rejects pending calls immediately", async () => {
  const client = new CodexIpcClient(endpoint, 1000); await client.connect();
  handle = () => {};
  const request = client.request("send", {}, 1);
  client.close();
  await expect(request).rejects.toThrow("closed");
});
