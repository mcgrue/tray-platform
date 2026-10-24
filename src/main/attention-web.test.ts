import http from "http";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { AttentionService } from "./attention-service";
import { createAttentionWeb, validateWebConfig } from "./attention-web";
import { WebReceipts } from "./web-receipts";
import { WebPushService } from "./web-push-service";

const origin = "https://fixture.ts.net";
let attention: AttentionService, web: ReturnType<typeof createAttentionWeb>, push: WebPushService, port: number;
let messages: jest.Mock, answers: jest.Mock;
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tray-web-api-"));
  attention = new AttentionService(path.join(dir, "attention.json")); await attention.initialize();
  await attention.upsert("codex", "a", { title: "Fixture", codexSessionId: "fixture" });
  const receipts = new WebReceipts(path.join(dir, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(dir, "push.json"), origin, async () => {}, ["owner"]); await push.initialize(attention.list());
  messages = jest.fn(async () => ({ sessionId: "fixture", turnId: "turn", delivery: "started" }));
  answers = jest.fn(async () => ({ remainingQuestions: 1 }));
  web = createAttentionWeb({ config: { origin, allowedUsers: ["owner"], port: 0 }, attention, receipts, push, assets: path.join(process.cwd(), "src/web"),
    operations: { message: messages, answer: answers, questions: async () => [] } as any });
  await new Promise<void>(resolve => web.server.listen(0, "127.0.0.1", resolve)); port = (web.server.address() as any).port;
});
afterEach(async () => { attention.close(); push.close(); const closed = new Promise<void>(resolve => web.server.once("close", resolve)); web.close(); await closed; });
function request(url: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method,
      headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner", ...headers } }, res => {
      let text = ""; res.on("data", value => text += value); res.on("end", () => resolve({ status: res.statusCode!, body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text, headers: res.headers }));
    }); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
async function headers() { return { Origin: origin, "Content-Type": "application/json", "X-Tray-CSRF": (await request("/api/session")).body.csrf }; }
test("all assets, snapshots and event streams require the explicit Tailscale identity", async () => {
  for (const route of ["/", "/api/attention", "/api/events", "/manifest.webmanifest", "/sw.js"]) {
    expect((await request(route, "GET", undefined, { "Tailscale-User-Login": "" })).status).toBe(403);
    expect((await request(route, "GET", undefined, { "Tailscale-User-Login": "other" })).status).toBe(403);
  }
  expect((await request("/api/attention")).body.items).toHaveLength(1);
  expect((await request("/api/attention", "GET", undefined, { Host: "localhost" })).status).toBe(403);
  expect((await request("/api/attention", "GET", undefined, { Origin: "https://evil.test" })).status).toBe(403);
  expect((await request("/api/attention", "GET", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
});
test("writes require exact origin, JSON, and CSRF; hooks and native controls are not exposed", async () => {
  const valid = await headers();
  const route = "/api/attention/codex/a/state", data = { state: "done" };
  expect((await request(route, "POST", data)).status).toBe(403);
  expect((await request(route, "POST", data, { ...valid, Origin: "https://evil.test" })).status).toBe(403);
  expect((await request(route, "POST", data, { ...valid, "X-Tray-CSRF": "0".repeat(64) })).status).toBe(403);
  expect((await request(route, "POST", data, { ...valid, "Content-Type": "text/plain" })).status).toBe(415);
  expect((await request(route, "POST", data, valid)).status).toBe(200);
  expect(attention.get("codex", "a")?.state).toBe("done");
  for (const route of ["/api/windows", "/api/attention/codex/a/go", "/DOCTEST_ALL_TESTS_PASS", "/../package.json", "/index.js.map"]) expect((await request(route)).status).toBe(404);
  expect((await request("/api/attention/x/y", "PUT", {}, valid)).status).toBe(405);
});
test("message API returns persistent receipts without sending duplicate or changed requests", async () => {
  const valid = await headers(), data = { requestId: `${Date.now()}-${randomUUID()}`, value: "hello" }, route = "/api/attention/codex/a/messages";
  const response = await request(route, "POST", data, valid); expect(response.body.state).toBe("succeeded");
  expect((await request(route, "POST", data, valid)).body).toEqual(response.body);
  expect(messages).toHaveBeenCalledTimes(1);
  expect((await request(route, "POST", { ...data, value: "different" }, valid)).status).toBe(409);
  expect((await request(`/api/requests/${data.requestId}`)).body.state).toBe("succeeded");
  expect((await request("/api/attention/codex/a/answers", "POST", { requestId: `${Date.now()}-${randomUUID()}`, value: [{ index: 0, answer: "yes" }] }, valid)).body.result.remainingQuestions).toBe(1);
});
test("SSE supplies an initial snapshot and subsequent durable state changes", async () => {
  const snapshots: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/api/events", headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner" } }, res => {
      let buffer = "";
      res.on("data", chunk => {
        buffer += chunk; let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = /^data: (.+)$/m.exec(event); if (!data) continue;
          snapshots.push(JSON.parse(data[1]));
          if (snapshots.length === 1) void attention.setState("codex", "a", "done");
          else { req.destroy(); resolve(); }
        }
      });
    }); req.on("error", reject);
  });
  expect(snapshots[0].items[0].state).toBe("pending"); expect(snapshots[1].items[0].state).toBe("done");
});
test("config is opt-in and rejects broad or insecure origins", () => {
  expect(validateWebConfig({ origin, allowedUsers: ["owner"] }).port).toBe(22223);
  for (const config of [{ origin: "http://fixture.ts.net", allowedUsers: ["owner"] }, { origin, allowedUsers: [] }, { origin: `${origin}/path`, allowedUsers: ["owner"] }, { origin, allowedUsers: ["owner"], port: 22222 }]) expect(() => validateWebConfig(config)).toThrow();
});
