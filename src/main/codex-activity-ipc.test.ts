import * as net from "net";
import { randomUUID } from "crypto";
import { CodexActivity } from "./codex-activity";
import { CodexIpcClient } from "./codex-ipc";
import { CodexInstance } from "../shared/codex-instances";

test("native IPC polling observes idle, work and waiting without starting, steering or approving turns", async () => {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tray-activity-${randomUUID()}` : `/tmp/tray-activity-${randomUUID()}.sock`;
  const sockets = new Set<net.Socket>(), methods: string[] = [], subscriptions: boolean[] = [];
  let runtime: any = { type: "idle" };
  const send = (socket: net.Socket, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4); methods.push(message.method);
        if (message.type === "request") send(socket, { type: "response", requestId: message.requestId,
          method: message.method, resultType: "success", handledByClientId: "owner", result: { clientId: "observer" } });
        if (message.type === "broadcast") {
          subscriptions.push(message.params.following);
          expect(message.targetClientIds).toEqual(["owner"]);
          expect(message.params).toMatchObject({ hostId: "local", conversationId: "thread" });
          if (message.params.following) send(socket, { type: "broadcast", method: "thread-stream-state-changed", version: 11,
            sourceClientId: "owner", params: { hostId: "local", conversationId: "thread",
              change: { type: "snapshot", conversationState: { id: "thread", threadRuntimeStatus: runtime } } } });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const rows: CodexInstance[] = [{ codexPid: 42, codexStartedAt: new Date(1000).toISOString(), vscodePid: 2,
    vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 3 }];
  const activity = new CodexActivity({ now: () => 2000, createClient: callback => new CodexIpcClient(endpoint, 500, callback),
    readOwners: async () => [{ processIdentity: "pid:42:identity", threadId: "thread", turnId: "turn", firstObservedAt: 1100,
      lastObservedAt: 1200, rolloutPath: "C:\\sessions\\thread.jsonl" }] });
  try {
    for (const [status, flags, expected] of [["idle", [], "idle"], ["active", [], "working"], ["active", ["waitingOnUserInput"], "waiting"]] as const) {
      runtime = { type: status, activeFlags: flags };
      await activity.enrich(rows); expect(rows[0].activity).toBe(expected);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect([...new Set(methods)]).toEqual(["initialize", "thread-owner-discovery", "thread-stream-following-changed"]);
    expect(subscriptions).toEqual([true, false, true, false, true, false]);
  } finally {
    activity.close(); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
