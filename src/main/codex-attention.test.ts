import { CodexAttention, originFromProcess } from "./codex-attention";
import { AttentionService, validateAttentionInput } from "./attention-service";
import { DesktopService } from "./desktop-service";
import { CodexOrigin } from "../shared/attention";
import { ProcessDescriptor, CodexInstancesSnapshot } from "../shared/codex-instances";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const startedAt = "2026-10-20T10:00:00Z";
const row = (pid: number, parentPid: number, name: string): ProcessDescriptor => ({ pid, parentPid, name, startedAt });
const processes = [row(1, 0, "Code.exe"), row(2, 1, "Code.exe"), row(3, 2, "codex.exe"),
  row(4, 3, "powershell.exe"), row(5, 4, "node.exe"), row(6, 1, "Code.exe"), row(7, 6, "codex.exe")];
const origin: CodexOrigin = { kind: "vscode-codex", codexPid: 3, codexStartedAt: startedAt, vscodePid: 2, vscodeStartedAt: startedAt };
const instance = { codexPid: 3, codexStartedAt: startedAt, vscodePid: 2, vscodeStartedAt: startedAt, vscodeMainPid: 1, title: "Workspace" };
const window = { kind: "window" as const, hwnd: "123", pid: 1, processStartedAt: startedAt, title: "Workspace" };
const snapshot = (): CodexInstancesSnapshot => ({ instances: [instance], supported: true, scanning: false, scannedAt: Date.now() });

function fixture() {
  const desktop = { listProcesses: jest.fn(async () => processes), areProcessesRunning: jest.fn(async () => true),
    listWindows: jest.fn(async () => [window]), activate: jest.fn(async () => {}) };
  const inventory = { list: jest.fn(snapshot), refresh: jest.fn(async () => snapshot()) };
  return { desktop, inventory, service: new CodexAttention(desktop, inventory) };
}

test("captures the caller's Codex ancestor, not a sibling in the same VS Code main process", () => {
  expect(originFromProcess(processes, 5, Date.parse(startedAt))).toEqual(origin);
  expect(originFromProcess(processes, 7, Date.parse(startedAt))).toMatchObject({ codexPid: 7, vscodePid: 6 });
});

test("rejects exited/recycled callers, broken ancestry, invalid times, cycles and non-VS Code Codex", () => {
  const at = Date.parse(startedAt);
  expect(originFromProcess(processes, 99, at)).toBeUndefined();
  expect(originFromProcess(processes, 5, at - 1)).toBeUndefined();
  expect(originFromProcess(processes.filter(p => p.pid !== 4), 5, at)).toBeUndefined();
  expect(originFromProcess(processes.map(p => p.pid === 4 ? { ...p, startedAt: "2030-01-01T00:00:00Z" } : p), 5, at)).toBeUndefined();
  expect(originFromProcess(processes.map(p => p.pid === 4 ? { ...p, startedAt: "invalid" } : p), 5, at)).toBeUndefined();
  expect(originFromProcess([row(4, 5, "powershell.exe"), row(5, 4, "node.exe")], 5, at)).toBeUndefined();
  expect(originFromProcess([row(3, 0, "codex.exe"), row(5, 3, "node.exe")], 5, at)).toBeUndefined();
});

test("replaces the transient hook observation with a durable verified origin; capture failure still delivers", async () => {
  const { service, desktop } = fixture();
  const input = { title: "Question", originProcess: { pid: 5, observedAt: Date.now() } };
  expect(await service.prepareInput("codex", input)).toEqual({ title: "Question", origin: { ...origin, title: "Workspace" } });
  desktop.listProcesses.mockRejectedValueOnce(new Error("Unavailable"));
  expect(await service.prepareInput("codex", input)).toEqual({ title: "Question" });
  expect(await service.prepareInput("other", input)).toBe(input);
  await expect(service.prepareInput("codex", { ...input, originProcess: { pid: 5, observedAt: Date.now() - 20000 } })).rejects.toThrow("observation");
});

test("origin survives persistence and explicit destination edits; malformed origins are rejected", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tray-origin-test-")), "attention.json");
  const attention = new AttentionService(file);
  await attention.initialize();
  await attention.upsert("codex", "question", { title: "Question", origin });
  await attention.setDestination("codex", "question", { kind: "url", url: "https://example.com/" });
  attention.close();
  const restored = new AttentionService(file); await restored.initialize();
  expect(restored.get("codex", "question")).toMatchObject({ origin, destination: { kind: "url" } });
  restored.close();
  for (const invalid of [{ ...origin, codexPid: 0 }, { ...origin, vscodeStartedAt: "nope" }, { ...origin, kind: "unknown" }]) {
    expect(() => validateAttentionInput({ title: "Question", origin: invalid })).toThrow();
  }
});

test("Go uses the live cached mapping, selects a unique HWND, and passes activation guards without rescanning", async () => {
  const { service, desktop, inventory } = fixture();
  desktop.listWindows.mockResolvedValue([window, { ...window, hwnd: "456", pid: 99 }]);
  await service.activate({ title: "Question", origin: { ...origin, title: "Old title" } });
  expect(inventory.refresh).not.toHaveBeenCalled();
  expect(desktop.listProcesses).not.toHaveBeenCalled();
  expect(desktop.areProcessesRunning).toHaveBeenCalledWith([{ pid: 3, startedAt }, { pid: 2, startedAt }]);
  expect(desktop.activate).toHaveBeenCalledWith(window, { title: "Workspace", processes: [
    { pid: 3, startedAt }, { pid: 2, startedAt },
  ] });
});

test.each(["duplicate", "missing", "recycled", "exited", "untitled", "scan-failed", "unsupported"])("Go rejects %s without focusing another window", async mode => {
  const { service, desktop, inventory } = fixture();
  if (mode === "duplicate") desktop.listWindows.mockResolvedValue([window, { ...window, hwnd: "456" }]);
  if (mode === "missing") desktop.listWindows.mockResolvedValue([]);
  if (["recycled", "exited", "scan-failed"].includes(mode)) desktop.areProcessesRunning.mockResolvedValue(false);
  if (mode === "recycled") inventory.refresh.mockResolvedValue({ ...snapshot(), instances: [{ ...instance, codexStartedAt: "2030-01-01T00:00:00Z" }] });
  if (mode === "exited") inventory.refresh.mockResolvedValue({ ...snapshot(), instances: [] });
  if (mode === "untitled") inventory.list.mockReturnValue({ ...snapshot(), instances: [{ ...instance, title: undefined }] });
  if (mode === "scan-failed") inventory.refresh.mockResolvedValue({ ...snapshot(), error: "failed" });
  if (mode === "unsupported") inventory.list.mockReturnValue({ ...snapshot(), supported: false });
  await expect(service.activate({ title: "Question", origin })).rejects.toThrow();
  expect(desktop.activate).not.toHaveBeenCalled();
  expect(inventory.refresh).toHaveBeenCalledTimes(["recycled", "exited", "scan-failed"].includes(mode) ? 1 : 0);
});

test("Go does not rescan a missing mapping or guess a replacement process", async () => {
  const { service, desktop, inventory } = fixture();
  inventory.list.mockReturnValue({ ...snapshot(), instances: [] });
  await expect(service.activate({ title: "Question", origin })).rejects.toThrow("not in the cached mapping");
  expect(desktop.areProcessesRunning).not.toHaveBeenCalled();
  expect(desktop.activate).not.toHaveBeenCalled();
  expect(inventory.refresh).not.toHaveBeenCalled();
});

test("a prior scan error does not block a live cached mapping", async () => {
  const { service, desktop, inventory } = fixture();
  inventory.list.mockReturnValue({ ...snapshot(), error: "Previous scan failed" });
  await service.activate({ title: "Question", origin });
  expect(desktop.activate).toHaveBeenCalledTimes(1);
  expect(inventory.refresh).not.toHaveBeenCalled();
});

test("process-check failure does not claim the process exited or start a scan", async () => {
  const { service, desktop, inventory } = fixture();
  desktop.areProcessesRunning.mockRejectedValue(new Error("Process check unavailable"));
  await expect(service.activate({ title: "Question", origin })).rejects.toThrow("Process check unavailable");
  expect(inventory.refresh).not.toHaveBeenCalled();
  expect(desktop.activate).not.toHaveBeenCalled();
});

test("manual destinations bypass discovery, and activation failures reach the UI without dismissing", async () => {
  const { service, desktop, inventory } = fixture();
  await service.activate({ title: "Question", origin, destination: window });
  expect(inventory.refresh).not.toHaveBeenCalled();
  expect(desktop.activate).toHaveBeenCalledWith(window);
  desktop.activate.mockRejectedValueOnce(new Error("Windows refused"));
  await expect(service.activate({ title: "Question", origin })).rejects.toThrow("Windows refused");
});

test("desktop forwards native activation guards", async () => {
  const runner = jest.fn(async () => ({ ok: true }));
  const desktop = new DesktopService({ runner, appPid: 999, openUrl: async () => {} });
  const guard = { title: "Workspace", processes: [{ pid: 3, startedAt }] };
  await desktop.activate(window, guard);
  expect(runner).toHaveBeenCalledWith({ command: "activate", appPid: 999, destination: window, guard });
  desktop.close();
});
