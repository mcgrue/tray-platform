import { promises as fs, readFileSync } from "fs";
import path = require("path");
import os = require("os");
import { AttentionService } from "./attention-service";

const services: AttentionService[] = [];
async function fixture(now?: () => number, onSound?: (id: string) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-attention-test-"));
  const file = path.join(directory, "attention.json");
  const service = new AttentionService(file, { now, onSound });
  services.push(service);
  await service.initialize();
  return { directory, file, service };
}
afterEach(() => { services.splice(0).forEach(service => service.close()); jest.restoreAllMocks(); jest.useRealTimers(); });

test("new requests persist before sound and observers, retries preserve disposition, snapshots detach", async () => {
  const sound = jest.fn();
  const { service, file } = await fixture(undefined, sound);
  const changed = jest.fn(() => expect(JSON.parse(readFileSync(file, "utf8")).items).toHaveLength(1));
  service.onChanged(changed);
  await service.upsert("builder", "one", { title: "Built", sound: "fanfare" });
  await service.setState("builder", "one", "done");
  await service.upsert("builder", "one", { title: "Built again", sound: "icq" });
  expect(service.get("builder", "one").state).toBe("done");
  expect(sound.mock.calls).toEqual([["fanfare"]]);
  const snapshot = service.list();
  snapshot.items[0].title = "untrusted mutation";
  expect(service.list().items[0].title).toBe("Built again");
  expect(changed).toHaveBeenCalledTimes(3);
});

test("serializes concurrent updates and survives a failed atomic replace without exposing it", async () => {
  const sound = jest.fn();
  const { service, file } = await fixture(undefined, sound);
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.upsert("batch", String(index), { title: `Job ${index}` })));
  const changed = jest.fn(); service.onChanged(changed);
  jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk refused replace"));
  await expect(service.upsert("batch", "failed", { title: "Failed", sound: "icq" })).rejects.toThrow("disk refused");
  expect(service.list().items).toHaveLength(12);
  expect(changed).not.toHaveBeenCalled(); expect(sound).not.toHaveBeenCalled();
  await service.upsert("batch", "recovered", { title: "Recovered", sound: "icq" });
  expect(service.list().items).toHaveLength(13);
  expect(JSON.parse(await fs.readFile(file, "utf8")).items).toHaveLength(13);
  expect(sound).toHaveBeenCalledTimes(1);
});

test("Done and Reopen do not schedule work or replay a sound", async () => {
  let now = 1000;
  const sound = jest.fn();
  const { service } = await fixture(() => now, sound);
  await service.upsert("robot", "answer", { title: "Answer me", sound: "icq" });
  jest.useFakeTimers({ doNotFake: ["performance"] });
  await service.setState("robot", "answer", "done");
  expect(jest.getTimerCount()).toBe(0);
  now += 86400000; jest.advanceTimersByTime(86400000);
  expect(service.get("robot", "answer").state).toBe("done");
  await service.setState("robot", "answer", "pending");
  expect(jest.getTimerCount()).toBe(0);
  expect(sound).toHaveBeenCalledTimes(1);
});

test("legacy deferred items migrate to Pending without losing metadata or replaying historical sounds", async () => {
  const { service, file } = await fixture(); service.close();
  const saved = ["overdue", "future", "pending", "done"].map((id, index) => ({ source: "task", id, title: `Human title ${id}`,
    description: "Keep this note", destination: { kind: "url", url: "https://example.com" }, sound: "icq", createdAt: 100, updatedAt: 200,
    state: index < 2 ? "snoozed" : id, ...(index < 2 ? { snoozedUntil: index ? Date.now() + 86400000 : 1 } : {}) }));
  await fs.writeFile(file, JSON.stringify({ version: 1, items: saved }));
  const sound = jest.fn();
  const restored = new AttentionService(file, { onSound: sound }); services.push(restored);
  jest.useFakeTimers({ doNotFake: ["performance"] });
  await restored.initialize();
  const expected = saved.map(({ snoozedUntil: _removed, ...item }) => ({ ...item, state: item.state === "snoozed" ? "pending" : item.state }));
  expect(restored.list().error).toBeUndefined();
  for (const item of expected) expect(restored.get(item.source, item.id)).toEqual(item);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 2, items: expected });
  expect(jest.getTimerCount()).toBe(0);
  expect(sound).not.toHaveBeenCalled();
  const replace = jest.spyOn(fs, "rename");
  const restarted = new AttentionService(file); services.push(restarted); await restarted.initialize();
  expect(restarted.list()).toEqual(restored.list()); expect(replace).not.toHaveBeenCalled();
});

test("a failed legacy migration preserves the original file and refuses later writes", async () => {
  const { service, file } = await fixture(); service.close();
  const raw = JSON.stringify({ version: 1, items: [{ source: "task", id: "legacy", title: "Keep", state: "snoozed", snoozedUntil: 5000, createdAt: 1, updatedAt: 2 }] });
  await fs.writeFile(file, raw);
  jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk refused migration"));
  const restored = new AttentionService(file); services.push(restored); await restored.initialize();
  expect(restored.list().error).toContain("read-only");
  expect(await fs.readFile(file, "utf8")).toBe(raw);
  await expect(restored.upsert("task", "other", { title: "No write" })).rejects.toMatchObject({ status: 503 });
});

test.each(["{broken", '{"version":99,"items":[]}', '{"version":1,"items":[{"title":"broken"}]}'])("preserves malformed and unknown stores: %s", async raw => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-attention-corrupt-"));
  const file = path.join(directory, "attention.json"); await fs.writeFile(file, raw);
  const service = new AttentionService(file); services.push(service); await service.initialize();
  expect(service.list().error).toContain("read-only");
  await expect(service.upsert("task", "one", { title: "Cannot save" })).rejects.toMatchObject({ status: 503 });
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});

test("validates requests, real sound IDs, destinations, and state actions", async () => {
  const { service } = await fixture();
  await expect(service.upsert("", "one", { title: "Bad" })).rejects.toMatchObject({ status: 400 });
  await expect(service.upsert("task", "one", { title: "Bad", sound: "success" })).rejects.toMatchObject({ status: 400 });
  await expect(service.upsert("task", "one", { title: "Bad", destination: { kind: "url", url: "file:///secret" } })).rejects.toMatchObject({ status: 400 });
  await expect(service.upsert("task", "one", { title: "Bad", destination: { kind: "window", hwnd: "0", pid: 1, processStartedAt: new Date().toISOString() } })).rejects.toMatchObject({ status: 400 });
  await service.upsert("task", "one", { title: "Good", destination: { kind: "url", url: "https://example.org/" } });
  await expect(service.setState("task", "one", "snoozed" as any)).rejects.toMatchObject({ status: 400 });
  expect(service.get("task", "one").state).toBe("pending");
  await expect(service.setState("task", "missing", "done")).rejects.toMatchObject({ status: 404 });
  await service.setState("task", "one", "done");
  await service.upsert("task", "one", { title: "Updated" });
  expect(service.get("task", "one").state).toBe("done");
});

test("observer and sound failures cannot reject a durable request; unsubscribe removes listeners", async () => {
  const { service } = await fixture(undefined, () => { throw new Error("renderer missing"); });
  const listener = jest.fn(() => { throw new Error("listener failed"); });
  const unsubscribe = service.onChanged(listener);
  await expect(service.upsert("task", "one", { title: "Persisted", sound: "icq" })).resolves.toMatchObject({ title: "Persisted" });
  unsubscribe(); await service.setState("task", "one", "done");
  expect(listener).toHaveBeenCalledTimes(1);
});

test("destination selection queues behind robot updates without overwriting metadata or disposition", async () => {
  const { service } = await fixture();
  await service.upsert("robot", "one", { title: "Original", description: "Original note" });
  await service.setState("robot", "one", "done");
  const destination = { kind: "window" as const, hwnd: "123", pid: 42, processStartedAt: "2026-10-16T00:00:00Z", title: "" };
  await Promise.all([
    service.upsert("robot", "one", { title: "Updated by robot", description: "New note", project: "Project" }),
    service.setDestination("robot", "one", destination),
  ]);
  expect(service.get("robot", "one")).toMatchObject({ title: "Updated by robot", description: "New note", project: "Project", destination, state: "done" });
  await expect(service.setDestination("robot", "missing", destination)).rejects.toMatchObject({ status: 404 });
  await expect(service.setDestination("robot", "one", { ...destination, hwnd: "0x123" })).rejects.toMatchObject({ status: 400 });
  await expect(service.setDestination("robot", "one", { ...destination, hwnd: "99999999999999999999" })).rejects.toMatchObject({ status: 400 });
});
