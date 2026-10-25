import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { WebPushService, validateSubscription } from "./web-push-service";
import { AttentionItem } from "../shared/attention";
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/fixture", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
const item = (state: AttentionItem["state"] = "pending", updatedAt = 100): AttentionItem => ({ source: "codex", id: "a", title: "Codex done", project: "D:\\dev\\tray", state, createdAt: 100, updatedAt });
test.each(["http://fcm.googleapis.com/fcm/send/a", "https://127.0.0.1/fcm/send/a", "https://fcm.googleapis.com.evil.test/fcm/send/a", "https://fcm.googleapis.com:444/fcm/send/a", "https://user@fcm.googleapis.com/fcm/send/a"])("push endpoint rejects SSRF destination %s", endpoint => {
  expect(() => validateSubscription({ ...subscription, endpoint })).toThrow();
});
test("notifications deduplicate, persist keys, and do not replay reopened items or startup backlog", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-push-")), "push.json");
  const send = jest.fn(async (..._args: any[]) => {}), push = new WebPushService(file, "https://fixture.ts.net", send, ["owner"]);
  await push.initialize({ items: [] }); const key = push.publicKey;
  await push.subscribe("owner", subscription); await push.subscribe("owner", subscription);
  push.update({ items: [item()] }); await push.settled(); expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ title: "Codex done", body: "tray" });
  push.update({ items: [item("pending", 101)] }); await push.settled(); expect(send).toHaveBeenCalledTimes(1);
  push.update({ items: [item("done", 102)] });
  push.update({ items: [item("pending", 103)] }); await push.settled(); expect(send).toHaveBeenCalledTimes(1); push.close();
  const reopened = new WebPushService(file, "https://fixture.ts.net", send, ["owner"]); await reopened.initialize({ items: [item("pending", 103)] });
  expect(reopened.publicKey).toBe(key); reopened.update({ items: [item("pending", 103)] }); await reopened.settled(); expect(send).toHaveBeenCalledTimes(1); reopened.close();
});
test("expired subscriptions are retired and disallowed owners receive no notifications", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-push-")), "push.json");
  const send = jest.fn(async () => { throw { statusCode: 410 }; });
  const push = new WebPushService(file, "https://fixture.ts.net", send, ["owner"]); await push.initialize({ items: [] });
  await push.subscribe("owner", subscription); push.update({ items: [item()] }); await push.settled();
  await expect(push.test("owner", subscription.endpoint)).rejects.toThrow("Enable notifications");
  await push.subscribe("other", subscription); push.update({ items: [{ ...item(), id: "b" }] }); await push.settled();
  expect(send).toHaveBeenCalledTimes(1); push.close();
});
