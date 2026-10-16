import { promises as fs, readFileSync } from "fs";
import path = require("path");
import os = require("os");
import { BookmarkService } from "./bookmark-service";
import { BookmarkInput } from "../shared/bookmarks";

const services: BookmarkService[] = [];
async function fixture(options: { now?: () => number; attentionExists?: (source: string, id: string) => boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-bookmark-test-"));
  const file = path.join(directory, "bookmarks.json");
  const service = new BookmarkService(file, options); services.push(service);
  await service.initialize();
  return { directory, file, service };
}
afterEach(() => { services.splice(0).forEach(service => service.close()); jest.restoreAllMocks(); });

test("robot updates and retries preserve human notes, destinations, associations, and creation time", async () => {
  let now = 100;
  const { service, file } = await fixture({ now: () => now });
  const destination = { kind: "url" as const, url: "https://example.org/repro" };
  await service.upsertRobot("robot", "one", { title: "Inspect repro", project: "Project", destination, robotHint: "Tests pass" });
  now = 200;
  await service.saveHuman("robot", "one", { title: "Inspect repro", humanNote: "Check inventory first" });
  now = 300;
  await service.upsertRobot("robot", "one", { robotHint: "Build passed too" } as BookmarkInput);
  const bookmark = service.get("robot", "one")!;
  expect(bookmark).toMatchObject({ title: "Inspect repro", project: "Project", destination, humanNote: "Check inventory first", robotHint: "Build passed too", createdAt: 100, updatedAt: 300 });
  const changed = jest.fn(); service.onChanged(changed);
  now = 400;
  await service.upsertRobot("robot", "one", { robotHint: "Build passed too" } as BookmarkInput);
  expect(service.get("robot", "one")!.updatedAt).toBe(300);
  expect(changed).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(file, "utf8")).bookmarks[0]).toEqual(bookmark);
  await expect(service.upsertRobot("robot", "one", { title: "Attack", humanNote: "Overwrite" })).rejects.toMatchObject({ status: 400 });
  expect(service.get("robot", "one")!.humanNote).toBe("Check inventory first");
});

test("human edits ignore stale robot hints and may clear a human note", async () => {
  const { service } = await fixture();
  await service.upsertRobot("agent", "one", { title: "Task", project: "P", robotHint: "Latest" });
  await service.saveHuman("agent", "one", { title: "Task", humanNote: "My note", robotHint: "Stale" });
  expect(service.get("agent", "one")).toMatchObject({ robotHint: "Latest", humanNote: "My note" });
  await service.saveHuman("agent", "one", { title: "Task", humanNote: "" });
  expect(service.get("agent", "one")).toMatchObject({ robotHint: "Latest", humanNote: "" });
});

test("concurrent author edits serialize without lost fields and observers run only after saving", async () => {
  const { service, file } = await fixture();
  await service.upsertRobot("agent", "one", { title: "Task", project: "P" });
  const changed = jest.fn(() => expect(JSON.parse(readFileSync(file, "utf8")).bookmarks[0]).toEqual(service.get("agent", "one")));
  service.onChanged(changed);
  await Promise.all([
    service.upsertRobot("agent", "one", { robotHint: "Robot" } as BookmarkInput),
    service.saveHuman("agent", "one", { title: "Human title", humanNote: "Human", robotHint: "Stale" }),
  ]);
  expect(service.get("agent", "one")).toMatchObject({ title: "Human title", robotHint: "Robot", humanNote: "Human", project: "P" });
  expect(changed).toHaveBeenCalledTimes(2);
  const snapshot = service.list(); snapshot.bookmarks[0].title = "Mutated";
  const item = service.get("agent", "one")!; item.project = "Mutated";
  expect(service.get("agent", "one")).toMatchObject({ title: "Human title", project: "P" });
});

test("failed atomic writes leave state unchanged and the mutation queue recovers", async () => {
  const { service, file } = await fixture();
  await service.saveHuman("human", "one", { title: "Task", project: "P", humanNote: "Original" });
  const changed = jest.fn(); service.onChanged(changed);
  jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(service.saveHuman("human", "one", { title: "Task", humanNote: "Not saved" })).rejects.toThrow("disk unavailable");
  expect(service.get("human", "one")!.humanNote).toBe("Original");
  expect(changed).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(file, "utf8")).bookmarks[0].humanNote).toBe("Original");
  await service.saveHuman("human", "one", { title: "Task", humanNote: "Recovered" });
  expect(service.get("human", "one")!.humanNote).toBe("Recovered");
  expect(changed).toHaveBeenCalledTimes(1);
});

test("task association validates existence when saving, supports completed tasks, and retains history on reload", async () => {
  let taskExists = true;
  const { service, file } = await fixture({ attentionExists: (source, id) => taskExists && source === "build" && id === "done-task" });
  await service.saveHuman("human", "one", { title: "Completed task note", attention: { source: "build", id: "done-task" }, humanNote: "Keep for later" });
  await expect(service.saveHuman("human", "missing", { title: "Missing", attention: { source: "build", id: "missing" } })).rejects.toMatchObject({ status: 404 });
  service.close(); taskExists = false;
  const restored = new BookmarkService(file, { attentionExists: () => false }); services.push(restored); await restored.initialize();
  expect(restored.get("human", "one")).toMatchObject({ humanNote: "Keep for later", attention: { source: "build", id: "done-task" } });
  expect(restored.list().error).toBeUndefined();
});

test.each(["{broken", '{"version":99,"bookmarks":[]}', '{"version":1,"bookmarks":[{"title":"broken"}]}'])("preserves corrupt or unsupported stores: %s", async raw => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-bookmark-corrupt-"));
  const file = path.join(directory, "bookmarks.json"); await fs.writeFile(file, raw);
  const service = new BookmarkService(file); services.push(service); await service.initialize();
  expect(service.list().error).toContain("read-only");
  await expect(service.upsertRobot("agent", "one", { title: "Cannot save", project: "P" })).rejects.toMatchObject({ status: 503 });
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});

test("validates title, association, notes, and destinations without poisoning later saves", async () => {
  const { service } = await fixture();
  for (const input of [
    { project: "P" }, { title: "No association" }, { title: " ", project: "P" },
    { title: "Task", project: "P", robotHint: 123 },
    { title: "Task", project: "P", robotHint: "x".repeat(20001) },
    { title: "Task", attention: { source: "", id: "a" } },
    { title: "Task", project: "P", destination: { kind: "url", url: "file:///secret" } },
  ]) await expect(service.upsertRobot("agent", "one", input as BookmarkInput)).rejects.toMatchObject({ status: 400 });
  await service.upsertRobot("agent", "one", { title: "Valid", project: "P" });
  expect(service.list().bookmarks).toHaveLength(1);
});

test("listener failure does not undo persistence; unsubscribe and close stop notifications/operations", async () => {
  const { service } = await fixture();
  const listener = jest.fn(() => { throw new Error("UI unavailable"); });
  const unsubscribe = service.onChanged(listener);
  await expect(service.upsertRobot("agent", "one", { title: "Task", project: "P" })).resolves.toMatchObject({ title: "Task" });
  unsubscribe();
  await service.upsertRobot("agent", "one", { title: "Updated" });
  expect(listener).toHaveBeenCalledTimes(1);
  service.close();
  await expect(service.saveHuman("agent", "one", { title: "Closed" })).rejects.toMatchObject({ status: 503 });
});
