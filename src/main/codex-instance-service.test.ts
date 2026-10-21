import { CodexInstanceService, CODEX_SCAN_INTERVAL_MS } from "./codex-instance-service";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 2, codexStartedAt: "2026-10-20T10:00:00Z", vscodePid: 1,
  vscodeStartedAt: "2026-10-20T09:00:00Z", vscodeMainPid: 1, title: "project" };

afterEach(() => jest.useRealTimers());

test("scans immediately, every five minutes, replaces exited processes, and stops on close", async () => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  const scan = jest.fn().mockResolvedValueOnce({ instances: [instance] }).mockResolvedValue({ instances: [] });
  const service = new CodexInstanceService({ scan, supported: true, now: () => 123 });
  service.start(); service.start();
  await service.refresh();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(service.list()).toMatchObject({ instances: [instance], scanning: false, scannedAt: 123 });
  jest.advanceTimersByTime(CODEX_SCAN_INTERVAL_MS - 1);
  expect(scan).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1);
  await service.refresh();
  expect(scan).toHaveBeenCalledTimes(2);
  expect(service.list().instances).toEqual([]);
  service.close();
  jest.advanceTimersByTime(CODEX_SCAN_INTERVAL_MS * 2);
  await service.refresh();
  expect(scan).toHaveBeenCalledTimes(2);
});

test("manual and scheduled requests share one in-flight scan", async () => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  let resolve!: (value: { instances: CodexInstance[] }) => void;
  const scan = jest.fn(() => new Promise<{ instances: CodexInstance[] }>(done => { resolve = done; }));
  const service = new CodexInstanceService({ scan, supported: true });
  service.start();
  const first = service.refresh();
  expect(service.refresh()).toBe(first);
  await Promise.resolve();
  jest.advanceTimersByTime(CODEX_SCAN_INTERVAL_MS * 2);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(service.list().scanning).toBe(true);
  resolve({ instances: [instance] });
  await first;
  service.close();
});

test("failed scans retain the prior inventory and timestamp, then recover", async () => {
  const scan = jest.fn().mockResolvedValueOnce({ instances: [instance] })
    .mockRejectedValueOnce(new Error("CIM unavailable"))
    .mockResolvedValueOnce({ instances: [{ ...instance, codexPid: 3 }], warning: "Title unavailable" });
  const service = new CodexInstanceService({ scan, supported: true, now: () => 123 });
  await service.refresh();
  await service.refresh();
  expect(service.list()).toMatchObject({ instances: [instance], scannedAt: 123, error: "CIM unavailable", scanning: false });
  await service.refresh();
  expect(service.list().error).toBeUndefined();
  expect(service.list().warning).toBe("Title unavailable");
  expect(service.list().instances[0].codexPid).toBe(3);
  const snapshot = service.list(); snapshot.instances[0].title = "mutated";
  expect(service.list().instances[0].title).toBe("project");
  service.close();
});

test("closing during discovery suppresses late publications", async () => {
  let resolve!: (value: { instances: CodexInstance[] }) => void;
  const service = new CodexInstanceService({ supported: true, scan: () => new Promise(done => { resolve = done; }) });
  const listener = jest.fn(); service.onChanged(listener);
  const pending = service.refresh();
  await Promise.resolve();
  service.close();
  resolve({ instances: [instance] });
  await pending;
  expect(listener).toHaveBeenCalledTimes(1);
  expect(service.list().instances).toEqual([]);
});

test("unsupported platforms do not schedule or invoke Windows discovery", async () => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  const scan = jest.fn();
  const service = new CodexInstanceService({ scan, supported: false });
  service.start();
  jest.advanceTimersByTime(CODEX_SCAN_INTERVAL_MS);
  await service.refresh();
  expect(scan).not.toHaveBeenCalled();
  expect(service.list().supported).toBe(false);
  service.close();
});
