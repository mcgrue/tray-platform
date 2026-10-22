import { CodexAttention } from "./codex-attention";
import { CodexInstancesSnapshot } from "../shared/codex-instances";
import { CodexOrigin, NavigationProgress } from "../shared/attention";

const startedAt = "2026-10-20T10:00:00Z";
const origin: CodexOrigin = { kind: "vscode-codex", codexPid: 3, codexStartedAt: startedAt,
  vscodePid: 2, vscodeStartedAt: startedAt };
const destination = { kind: "window" as const, hwnd: "123", pid: 1, processStartedAt: startedAt, title: "dredmor" };
const snapshot: CodexInstancesSnapshot = { supported: true, scanning: false, instances: [
  { ...origin, vscodeMainPid: 1, title: "dredmor" },
] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("reports the slow rescan immediately and success only after native activation confirms it", async () => {
  const scan = deferred<CodexInstancesSnapshot>();
  const activation = deferred<void>();
  const activating = deferred<void>();
  const progress: NavigationProgress[] = [];
  const desktop = { listProcesses: jest.fn(), listWindows: jest.fn(async () => [destination]),
    activate: jest.fn(() => { activating.resolve(); return activation.promise; }) };
  const inventory = { list: jest.fn(), refresh: jest.fn(() => scan.promise) };
  const service = new CodexAttention(desktop, inventory);
  // Like the reported Dredmor item, the saved origin has no window title.
  const pending = service.activate({ title: "Dredmor notification test", origin }, update => progress.push(update));
  expect(progress).toEqual([{ phase: "scanning" }]);
  expect(inventory.refresh).toHaveBeenCalledTimes(1);
  expect(desktop.activate).not.toHaveBeenCalled();
  scan.resolve(snapshot);
  await activating.promise;
  expect(progress).toEqual([{ phase: "scanning" }, { phase: "activating", destination: "dredmor" }]);
  expect(desktop.activate).toHaveBeenCalledWith(destination, { title: "dredmor", processes: [
    { pid: 3, startedAt }, { pid: 2, startedAt },
  ] });
  activation.resolve();
  await pending;
  expect(progress[2]).toEqual({ phase: "opened", destination: "dredmor" });
});

test.each(["scan", "activation"])("%s failure never reports that the window opened", async stage => {
  const progress: NavigationProgress[] = [];
  const desktop = { listProcesses: jest.fn(), listWindows: jest.fn(async () => [destination]),
    activate: jest.fn(async () => { throw new Error("Windows refused"); }) };
  const inventory = { list: jest.fn(), refresh: jest.fn(async () => stage === "scan"
    ? { ...snapshot, error: "Scan failed" } : snapshot) };
  const service = new CodexAttention(desktop, inventory);
  await expect(service.activate({ title: "Question", origin }, update => progress.push(update))).rejects.toThrow();
  expect(progress.some(update => update.phase === "opened")).toBe(false);
  expect(desktop.activate).toHaveBeenCalledTimes(stage === "scan" ? 0 : 1);
});

test("an explicit destination reports opening without claiming a rescan", async () => {
  const progress: NavigationProgress[] = [];
  const desktop = { listProcesses: jest.fn(), listWindows: jest.fn(), activate: jest.fn(async () => {}) };
  const inventory = { list: jest.fn(), refresh: jest.fn() };
  const service = new CodexAttention(desktop, inventory);
  await service.activate({ title: "Question", origin, destination }, update => progress.push(update));
  expect(inventory.refresh).not.toHaveBeenCalled();
  expect(progress).toEqual([{ phase: "activating", destination: "dredmor" }, { phase: "opened", destination: "dredmor" }]);
});
