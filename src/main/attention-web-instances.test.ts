import http from "http";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { AttentionService } from "./attention-service";
import { createAttentionWeb } from "./attention-web";
import { WebReceipts } from "./web-receipts";
import { WebPushService } from "./web-push-service";
import { CodexInstanceService } from "./codex-instance-service";

const origin = "https://fixture.ts.net";
const target = { codexPid: 42, codexStartedAt: "2026-10-24T10:00:00Z" };
const base = `/api/codex-instances/42/${encodeURIComponent(target.codexStartedAt)}`;
let attention: AttentionService, web: ReturnType<typeof createAttentionWeb>, push: WebPushService, instances: CodexInstanceService, port: number;
let send: jest.Mock, conversations: jest.Mock, scan: jest.Mock;
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tray-web-instances-"));
  attention = new AttentionService(path.join(dir, "attention.json")); await attention.initialize();
  const receipts = new WebReceipts(path.join(dir, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(dir, "push.json"), origin, async () => {}, ["owner", "second"]); await push.initialize(attention.list());
  scan = jest.fn(async () => ({ instances: [{ ...target, vscodePid: 1, vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 1, title: "Fixture", activity: "idle" as const }] }));
  instances = new CodexInstanceService({ scan, supported: true }); await instances.refresh();
  send = jest.fn(async (_target, id) => ({ sessionId: id || "created", turnId: "turn", delivery: "started" }));
  conversations = jest.fn(async () => [{ id: "saved", title: "Saved conversation", lastActiveAt: 1 }]);
  web = createAttentionWeb({ config: { origin, allowedUsers: ["owner", "second"], port: 0 }, attention, receipts, push, assets: path.join(process.cwd(), "src/web"),
    operations: {} as any, codex: { instances, messages: { send, conversations } } });
  await new Promise<void>(resolve => web.server.listen(0, "127.0.0.1", resolve)); port = (web.server.address() as any).port;
});
afterEach(async () => { instances.close(); attention.close(); push.close(); const closed = new Promise<void>(resolve => web.server.once("close", resolve)); web.close(); await closed; });
function request(url: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method,
      headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner", ...headers } }, res => {
      let text = ""; res.on("data", value => text += value); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    }); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
async function headers(user = "owner") { return { Origin: origin, "Content-Type": "application/json", "Tailscale-User-Login": user,
  "X-Tray-CSRF": (await request("/api/session", "GET", undefined, { "Tailscale-User-Login": user })).body.csrf }; }

test("instance snapshots and conversations require the same Tailscale authorization as the inbox", async () => {
  for (const route of ["/api/codex-instances", `${base}/conversations`]) {
    expect((await request(route, "GET", undefined, { "Tailscale-User-Login": "" })).status).toBe(403);
    expect((await request(route, "GET", undefined, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await request(route, "GET", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  }
  expect((await request("/api/codex-instances")).body.instances[0]).toMatchObject({ ...target, activity: "idle" });
  expect((await request(`${base}/conversations`)).body[0].id).toBe("saved");
  expect(conversations).toHaveBeenCalledWith(target); expect(send).not.toHaveBeenCalled();
});

test("refresh and messaging require exact origin, CSRF and JSON", async () => {
  const valid = await headers();
  for (const route of ["/api/codex-instances/refresh", `${base}/messages`]) {
    expect((await request(route, "POST", {})).status).toBe(403);
    expect((await request(route, "POST", {}, { ...valid, "X-Tray-CSRF": "0".repeat(64) })).status).toBe(403);
    expect((await request(route, "POST", {}, { ...valid, "Content-Type": "text/plain" })).status).toBe(415);
  }
  expect(send).not.toHaveBeenCalled(); expect(scan).toHaveBeenCalledTimes(1);
  expect((await request("/api/codex-instances/refresh", "POST", {}, valid)).body.instances).toHaveLength(1);
  expect(scan).toHaveBeenCalledTimes(2);
});

test.each(["", "saved"])("%s selection is sent once, and replay retains the original receipt", async conversationId => {
  const valid = await headers(), requestId = `${Date.now()}-${randomUUID()}`, value = { conversationId, message: "Literal café\n$(text)" };
  const first = await request(`${base}/messages`, "POST", { requestId, value }, valid);
  expect(first.body).toMatchObject({ state: "succeeded", result: { sessionId: conversationId || "created" } });
  expect(send).toHaveBeenCalledWith(target, conversationId, value.message);
  expect((await request(`${base}/messages`, "POST", { requestId, value }, valid)).body).toEqual(first.body);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await request(`${base}/messages`, "POST", { requestId, value: { ...value, message: "changed" } }, valid)).status).toBe(409);
  expect((await request(`/api/requests/${requestId}`)).body).toEqual(first.body);
  expect((await request(`/api/requests/${requestId}`, "GET", undefined, { "Tailscale-User-Login": "second" })).status).toBe(404);
  expect((await request(`${base}/messages`, "POST", { requestId, value }, await headers("second"))).status).toBe(409);
});

test("uncertain delivery is recorded and never replayed", async () => {
  send.mockRejectedValue(new Error("Codex disconnected after admission"));
  const valid = await headers(), data = { requestId: `${Date.now()}-${randomUUID()}`, value: { conversationId: "", message: "hello" } };
  const first = await request(`${base}/messages`, "POST", data, valid);
  expect(first.body.state).toBe("unknown");
  expect((await request(`${base}/messages`, "POST", data, valid)).body).toEqual(first.body);
  expect(send).toHaveBeenCalledTimes(1);
});

test("rejects malformed identities and methods before dispatch", async () => {
  for (const url of ["/api/codex-instances/42/%ZZ/conversations", "/api/codex-instances/42/not-a-date/conversations",
    "/api/codex-instances/999999999999999999999/2026-10-24/conversations"]) expect((await request(url)).status).toBe(400);
  expect((await request(`${base}/messages`)).status).toBe(405);
  expect((await request(`${base}/conversations`, "POST", {}, await headers())).status).toBe(405);
  expect(send).not.toHaveBeenCalled(); expect(conversations).not.toHaveBeenCalled();
});

test("SSE publishes initial and updated instances alongside inbox events", async () => {
  const snapshots: any[] = [], types: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/api/events", headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner" } }, res => {
      let buffer = "";
      res.on("data", chunk => {
        buffer += chunk; let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(event)?.[1]; if (type) types.push(type);
          if (type !== "codex-instances") continue;
          snapshots.push(JSON.parse(/^data: (.+)$/m.exec(event)![1]));
          if (snapshots.length === 1) void instances.refresh();
          if (snapshots.length >= 3) { req.destroy(); resolve(); }
        }
      });
    }); req.on("error", reject);
  });
  expect(types[0]).toBe("attention"); expect(snapshots.map(snapshot => snapshot.scanning)).toEqual([false, true, false]);
});
