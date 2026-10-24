import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { WebReceipts } from "./web-receipts";

const id = () => `${Date.now()}-${randomUUID()}`;
test("durable receipts deduplicate concurrent/restarted requests and bind identity plus payload", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-receipts-")), "store.json");
  const receipts = new WebReceipts(file); await receipts.initialize();
  const key = id(), work = jest.fn(async () => ({ turnId: "turn" }));
  await Promise.all([receipts.run("owner", key, "text", work), receipts.run("owner", key, "text", work)]);
  expect(work).toHaveBeenCalledTimes(1);
  const reopened = new WebReceipts(file); await reopened.initialize();
  expect(await reopened.run("owner", key, "text", work)).toEqual({ state: "succeeded", result: { turnId: "turn" }, error: undefined });
  expect(work).toHaveBeenCalledTimes(1);
  expect(reopened.get("other", key)).toBeUndefined();
  await expect(reopened.run("other", key, "text", work)).rejects.toThrow("already used");
  await expect(reopened.run("owner", key, "changed", work)).rejects.toThrow("already used");
});
test("unconfirmed sends and expired IDs never replay", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-receipts-")), "store.json");
  const receipts = new WebReceipts(file); await receipts.initialize();
  const key = id(), failed = jest.fn(async () => { throw new Error("Connection lost"); });
  expect((await receipts.run("owner", key, {}, failed)).state).toBe("unknown");
  const reopened = new WebReceipts(file); await reopened.initialize();
  await reopened.run("owner", key, {}, failed); expect(failed).toHaveBeenCalledTimes(1);
  await expect(reopened.run("owner", `${Date.now() - 2 * 86400000}-${randomUUID()}`, {}, failed)).rejects.toThrow("expired");
});
test("delivery is never attempted when recording its admission fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-receipts-"));
  const file = path.join(directory, "missing", "store.json"), receipts = new WebReceipts(file);
  await receipts.initialize(); await fs.writeFile(path.join(directory, "missing"), "obstruction");
  const work = jest.fn(); await expect(receipts.run("owner", id(), {}, work)).rejects.toThrow(); expect(work).not.toHaveBeenCalled();
});
