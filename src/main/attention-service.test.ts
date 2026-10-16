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

test("snooze expires once after saving, and reopening does not replay a sound", async () => {
  let now = 1000;
  const sound = jest.fn();
  const { service } = await fixture(() => now, sound);
  await service.upsert("robot", "answer", { title: "Answer me", sound: "icq" });
  jest.useFakeTimers({ doNotFake: ["performance"] });
  await service.setState("robot", "answer", "snoozed", 5);
  const expired = new Promise<void>(resolve => service.onChanged(snapshot => { if (snapshot.items[0].state === "pending") resolve(); }));
  now += 300000;
  jest.advanceTimersByTime(300000);
  await expired;
  expect(sound).toHaveBeenCalledTimes(2);
  await service.setState("robot", "answer", "done");
  await service.setState("robot", "answer", "pending");
  expect(sound).toHaveBeenCalledTimes(2);
});

test("restart restores future snoozes and normalizes overdue snoozes without historical sounds", async () => {
  let now = 1000;
  const { service, file } = await fixture(() => now);
  await service.upsert("task", "one", { title: "First", sound: "icq" });
  await service.setState("task", "one", "snoozed", 5);
  await service.upsert("task", "two", { title: "Second", sound: "icq" });
  await service.setState("task", "two", "snoozed", 60);
  service.close(); now += 300001;
  const sound = jest.fn();
  const restored = new AttentionService(file, { now: () => now, onSound: sound }); services.push(restored);
  await restored.initialize();
  expect(restored.get("task", "one").state).toBe("pending");
  expect(restored.get("task", "two").state).toBe("snoozed");
  expect(JSON.parse(await fs.readFile(file, "utf8")).items[0].state).toBe("pending");
  expect(sound).not.toHaveBeenCalled();
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
  await expect(service.setState("task", "one", "snoozed", 1)).rejects.toMatchObject({ status: 400 });
  await expect(service.setState("task", "missing", "done")).rejects.toMatchObject({ status: 404 });
  await service.setState("task", "one", "snoozed", 15);
  const until = service.get("task", "one").snoozedUntil;
  await service.upsert("task", "one", { title: "Updated" });
  expect(service.get("task", "one").snoozedUntil).toBe(until);
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
