import path from "path";
import { DesktopService } from "./desktop-service";

const identities = [{ pid: 123, startedAt: "2026-10-22T10:00:00Z" }, { pid: 456, startedAt: "2026-10-22T09:00:00Z" }];

test("checks only the supplied process identities and distinguishes stale identity from helper failure", async () => {
  const runner = jest.fn().mockResolvedValueOnce({ ok: true, result: true }).mockResolvedValueOnce({ ok: true, result: false })
    .mockResolvedValueOnce({ ok: false, error: "Access denied" }).mockResolvedValueOnce({ ok: true, result: [] });
  const service = new DesktopService({ runner, appPid: 999, openUrl: jest.fn() });
  expect(await service.areProcessesRunning(identities)).toBe(true);
  expect(runner).toHaveBeenCalledWith({ command: "check-processes", appPid: 999, processIdentities: identities });
  expect(await service.areProcessesRunning(identities)).toBe(false);
  await expect(service.areProcessesRunning(identities)).rejects.toThrow("Access denied");
  await expect(service.areProcessesRunning(identities)).rejects.toThrow("invalid data");
  service.close();
});

test("rejects invalid identities and closed service without invoking the helper", async () => {
  const runner = jest.fn();
  const service = new DesktopService({ runner, openUrl: jest.fn() });
  for (const invalid of [[], [{ pid: 0, startedAt: identities[0].startedAt }], [{ pid: 1, startedAt: "invalid" }]]) {
    await expect(service.areProcessesRunning(invalid)).rejects.toThrow("Invalid process identities");
  }
  service.close();
  await expect(service.areProcessesRunning(identities)).rejects.toThrow("closed");
  expect(runner).not.toHaveBeenCalled();
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("native targeted check detects live, exited, and reused process identities", async () => {
  const service = new DesktopService({ openUrl: jest.fn(), helperPath: path.join(__dirname, "resources", "desktop-helper.ps1") });
  try {
    const current = (await service.listProcesses()).find(entry => entry.pid === process.pid)!;
    expect(current).toBeDefined();
    const live = { pid: current.pid, startedAt: current.startedAt };
    expect(await service.areProcessesRunning([live])).toBe(true);
    expect(await service.areProcessesRunning([{ ...live, startedAt: "2000-01-01T00:00:00Z" }])).toBe(false);
    expect(await service.areProcessesRunning([live, { pid: 2147483647, startedAt: live.startedAt }])).toBe(false);
  } finally { service.close(); }
}, 30000);
