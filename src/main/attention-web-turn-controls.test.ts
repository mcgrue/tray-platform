import http from "http";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { AttentionService } from "./attention-service";
import { createAttentionWeb } from "./attention-web";
import { WebReceipts } from "./web-receipts";
import { WebPushService } from "./web-push-service";
import { CodexTurnNotStartedError } from "../shared/codex-turn-controls";

const origin = "https://fixture.ts.net", target = { codexPid: 42, codexStartedAt: "2026-11-11T10:00:00Z" };
let attention: AttentionService, web: ReturnType<typeof createAttentionWeb>, push: WebPushService, port: number;
let instanceSend: jest.Mock, inboxSend: jest.Mock, instanceSettings: jest.Mock, inboxSettings: jest.Mock;
beforeEach(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-web-turn-controls-"));
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  await attention.upsert("codex", "card", { title: "Fixture", codexSessionId: "session" });
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), origin, async () => {}, ["owner"]); await push.initialize(attention.list());
  instanceSend = jest.fn(async () => ({ sessionId: "session", turnId: "turn", delivery: "started" }));
  inboxSend = jest.fn(async () => ({ sessionId: "session", turnId: "turn", delivery: "started" }));
  const settings = { available: true, current: { model: "model-a", effort: "medium" }, models: [] };
  instanceSettings = jest.fn(async () => settings); inboxSettings = jest.fn(async () => settings);
  const instances = { list: () => ({ instances: [], supported: true, scanning: false }),
    refresh: async () => ({ instances: [], supported: true, scanning: false }), onChanged: () => () => {} };
  web = createAttentionWeb({ config: { origin, allowedUsers: ["owner"], port: 0 }, attention, receipts, push,
    assets: path.join(process.cwd(), "src/web"), operations: { message: inboxSend, turnSettings: inboxSettings } as any,
    codex: { instances: instances as any, messages: { conversations: async () => [], send: instanceSend, turnSettings: instanceSettings } as any } });
  await new Promise<void>(resolve => web.server.listen(0, "127.0.0.1", resolve));
  port = (web.server.address() as any).port;
});
afterEach(async () => { attention.close(); push.close(); const closed = new Promise<void>(resolve => web.server.once("close", resolve)); web.close(); await closed; });
function request(url: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method,
      headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner", ...headers } }, res => {
      let text = ""; res.on("data", value => text += value);
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    }); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
async function headers() { return { Origin: origin, "Content-Type": "application/json",
  "X-Tray-CSRF": (await request("/api/session")).body.csrf }; }

test("phone settings reads and selected sends use the same authenticated conversation and receipt", async () => {
  const instanceRoute = `/api/codex-instances/42/${encodeURIComponent(target.codexStartedAt)}`;
  expect((await request(`${instanceRoute}/turn-settings?conversationId=saved`)).body.current.model).toBe("model-a");
  expect(instanceSettings).toHaveBeenCalledWith(target, "saved");
  expect((await request("/api/attention/codex/card/turn-settings")).body.current.effort).toBe("medium");
  expect(inboxSettings).toHaveBeenCalledWith("codex", "card");
  const options = { mode: "plan", model: "model-a", effort: "high" }, valid = await headers();
  const instanceValue = { conversationId: "saved", message: "Plan fixture", options };
  const first = { requestId: `${Date.now()}-${randomUUID()}`, value: instanceValue };
  expect((await request(`${instanceRoute}/messages`, "POST", first, valid)).body.state).toBe("succeeded");
  expect(instanceSend).toHaveBeenCalledWith(target, "saved", "Plan fixture", options);
  expect((await request(`${instanceRoute}/messages`, "POST", first, valid)).body.state).toBe("succeeded");
  expect(instanceSend).toHaveBeenCalledTimes(1);
  expect((await request(`${instanceRoute}/messages`, "POST", { ...first,
    value: { ...instanceValue, options: { ...options, effort: "medium" } } }, valid)).status).toBe(409);
  const inbox = { requestId: `${Date.now()}-${randomUUID()}`, value: { message: "Plan inbox", options } };
  expect((await request("/api/attention/codex/card/messages", "POST", inbox, valid)).body.state).toBe("succeeded");
  expect(inboxSend).toHaveBeenCalledWith("codex", "card", "Plan inbox", options);
});

test("active-turn rejection is recorded as not sent and a later request can start", async () => {
  instanceSend.mockRejectedValueOnce(new CodexTurnNotStartedError("Codex is working. Wait for this turn to finish; your draft is preserved."));
  const route = `/api/codex-instances/42/${encodeURIComponent(target.codexStartedAt)}/messages`;
  const valid = await headers(), value = { conversationId: "saved", message: "Plan later", options: { mode: "plan" } };
  const firstId = `${Date.now()}-${randomUUID()}`;
  const first = await request(route, "POST", { requestId: firstId, value }, valid);
  expect(first.body).toMatchObject({ state: "rejected", error: expect.stringContaining("Wait for this turn") });
  expect((await request(`/api/requests/${firstId}`)).body.state).toBe("rejected");
  const second = await request(route, "POST", { requestId: `${Date.now()}-${randomUUID()}`, value }, valid);
  expect(second.body.state).toBe("succeeded");
  expect(instanceSend).toHaveBeenCalledTimes(2);
});
