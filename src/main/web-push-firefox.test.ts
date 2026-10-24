import { createECDH } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { validateSubscription, WebPushService } from "./web-push-service";

const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
const subscription = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/fixture-token",
  keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } };

test("Firefox endpoints remain opaque and survive registration/restart with encrypted VAPID delivery", async () => {
  expect(validateSubscription(subscription)).toEqual(subscription);
  const nextVersion = { ...subscription, endpoint: "https://updates.push.services.mozilla.com/future-path/opaque?token=fixture" };
  expect(validateSubscription(nextVersion)).toEqual(nextVersion);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-firefox-push-")), "push.json");
  const sender = jest.fn(async (value, payload, options) => {
    const request = require("web-push").generateRequestDetails(value, payload, options);
    expect(request.endpoint).toBe(subscription.endpoint);
    expect(request.headers.Authorization).toMatch(/^vapid /);
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect(request.body.toString()).not.toContain("Notifications are working");
  });
  const first = new WebPushService(file, "https://fixture.ts.net", sender, ["owner"]); await first.initialize({ items: [] });
  await first.subscribe("owner", subscription); const publicKey = first.publicKey; first.close();
  const reopened = new WebPushService(file, "https://fixture.ts.net", sender, ["owner"]); await reopened.initialize({ items: [] });
  expect(reopened.publicKey).toBe(publicKey); await reopened.test("owner", subscription.endpoint);
  expect(sender).toHaveBeenCalledTimes(1); reopened.close();
});

test.each([
  "http://updates.push.services.mozilla.com/wpush/v2/fixture",
  "https://updates.push.services.mozilla.com.evil.test/wpush/v2/fixture",
  "https://updates.push.services.mozilla.com@127.0.0.1/wpush/v2/fixture",
  "https://updates.push.services.mozilla.com:444/wpush/v2/fixture",
  "https://updates.push.services.mozilla.com/wpush/v2/fixture#fragment",
  "https://updates.push.services.mozilla.com/",
  "https://127.0.0.1/wpush/v2/fixture",
])("Firefox support does not admit unsafe endpoint %s", endpoint => {
  expect(() => validateSubscription({ ...subscription, endpoint })).toThrow();
});
