import { DesktopService, DesktopRequest } from "./desktop-service";
import { WindowDestination } from "../shared/attention";
import * as path from "path";

const destination: WindowDestination = {
  kind: "window", hwnd: "9876543210123456", pid: 135,
  processStartedAt: "2026-10-16T10:11:12.1234567Z", title: "Project — editor",
};

describe("DesktopService", () => {
  test("lists stable string window identities and excludes this application's process", async () => {
    const runner = jest.fn(async () => ({ ok: true, result: [destination, { ...destination, pid: 42 }] }));
    const service = new DesktopService({ appPid: 42, openUrl: jest.fn(), runner });
    expect(await service.listWindows()).toEqual([destination]);
    expect(runner).toHaveBeenCalledWith({ command: "list", appPid: 42 });
    service.close();
  });

  test("captures foreground before the caller changes focus, with no activation request", async () => {
    const requests: DesktopRequest[] = [];
    const service = new DesktopService({ appPid: 42, openUrl: jest.fn(), runner: async request => {
      requests.push(request);
      return { ok: true, result: destination };
    } });
    expect(await service.captureForeground()).toEqual(destination);
    expect(requests).toEqual([{ command: "foreground", appPid: 42 }]);
  });

  test("returns no capture for its own window or no foreground window", async () => {
    const runner = jest.fn().mockResolvedValueOnce({ ok: true, result: { ...destination, pid: 42 } })
      .mockResolvedValueOnce({ ok: true, result: null });
    const service = new DesktopService({ appPid: 42, openUrl: jest.fn(), runner });
    expect(await service.captureForeground()).toBeUndefined();
    expect(await service.captureForeground()).toBeUndefined();
  });

  test("passes every identity field for immediate helper revalidation and surfaces stale/refused errors", async () => {
    const runner = jest.fn().mockResolvedValueOnce({ ok: true, result: null })
      .mockResolvedValueOnce({ ok: false, error: "The selected window has closed or changed. Choose its current window again." })
      .mockResolvedValueOnce({ ok: false, error: "Windows refused to activate this window." });
    const service = new DesktopService({ appPid: 42, openUrl: jest.fn(), runner });
    await service.activate(destination);
    expect(runner).toHaveBeenCalledWith({ command: "activate", appPid: 42, destination });
    await expect(service.activate(destination)).rejects.toThrow("closed or changed");
    await expect(service.activate(destination)).rejects.toThrow("refused");
  });

  test("opens only valid HTTP(S) links without invoking the Windows helper", async () => {
    const runner = jest.fn();
    const openUrl = jest.fn().mockResolvedValue(undefined);
    const service = new DesktopService({ openUrl, runner });
    await service.activate({ kind: "url", url: "https://example.com/a?q=hello" });
    await service.activate({ kind: "url", url: "http://localhost:3333" });
    for (const url of ["file:///C:/secret", "javascript:alert(1)", "not a url", "powershell://command"]) {
      await expect(service.activate({ kind: "url", url })).rejects.toThrow();
    }
    expect(openUrl.mock.calls).toEqual([["https://example.com/a?q=hello"], ["http://localhost:3333/"]]);
    expect(runner).not.toHaveBeenCalled();
  });

  test("rejects malformed destination identities before spawning a helper", async () => {
    const runner = jest.fn();
    const service = new DesktopService({ appPid: 42, openUrl: jest.fn(), runner });
    for (const bad of [{ hwnd: "1; calc" }, { hwnd: "0" }, { pid: -1 }, { pid: 42 }, { processStartedAt: "yesterday" }]) {
      await expect(service.activate({ ...destination, ...bad })).rejects.toThrow();
    }
    expect(runner).not.toHaveBeenCalled();
  });

  test("rejects invalid helper output and preserves helper installation errors", async () => {
    const runner = jest.fn().mockResolvedValueOnce("garbage").mockResolvedValueOnce({ ok: true, result: [42] })
      .mockRejectedValueOnce(new Error("Cannot start Windows helper: unavailable"));
    const service = new DesktopService({ openUrl: jest.fn(), runner });
    await expect(service.listWindows()).rejects.toThrow("invalid data");
    await expect(service.listWindows()).rejects.toThrow("invalid data");
    await expect(service.listWindows()).rejects.toThrow("Cannot start");
  });

  test("closing prevents any further desktop or URL operation", async () => {
    const runner = jest.fn();
    const openUrl = jest.fn();
    const service = new DesktopService({ openUrl, runner });
    service.close();
    await expect(service.listWindows()).rejects.toThrow("closed");
    await expect(service.activate({ kind: "url", url: "https://example.com" })).rejects.toThrow("closed");
    expect(runner).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("native helper discovers and captures without activating, and rejects a stale destination", async () => {
  const service = new DesktopService({
    openUrl: jest.fn(), helperPath: path.join(__dirname, "resources", "desktop-helper.ps1"),
  });
  try {
    const windows = await service.listWindows();
    expect(Array.isArray(windows)).toBe(true);
    expect(windows.every(window => typeof window.hwnd === "string" && window.pid !== process.pid)).toBe(true);
    const foreground = await service.captureForeground();
    if (foreground) expect(typeof foreground.hwnd).toBe("string");
    await expect(service.activate({ ...destination, hwnd: "1", pid: 2147483647 })).rejects.toThrow("closed or changed");
  } finally { service.close(); }
}, 30000);

windowsTest("native helper is terminated when its bounded timeout expires", async () => {
  const service = new DesktopService({
    openUrl: jest.fn(), timeoutMs: 1, helperPath: path.join(__dirname, "resources", "desktop-helper.ps1"),
  });
  try { await expect(service.listWindows()).rejects.toThrow("timed out"); }
  finally { service.close(); }
});
