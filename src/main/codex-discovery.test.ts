import { CodexDiscovery, codeUserDataPath, findCodexProcesses, parseCodeStatus, workspaceLocation, workspaceStorageId } from "./codex-discovery";
import { DesktopService } from "./desktop-service";
import { ProcessDescriptor } from "../shared/codex-instances";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const processRow = (pid: number, parentPid: number, name: string, startedAt = "2026-10-20T10:00:00Z"): ProcessDescriptor => ({ pid, parentPid, name, startedAt });

test("maps direct and indirect Codex descendants to their own VS Code host, excluding desktop and standalone Codex", () => {
  const matches = findCodexProcesses([
    processRow(1, 0, "Code.exe"), processRow(2, 1, "Code.exe"), processRow(3, 1, "Code.exe"),
    processRow(4, 2, "codex.exe"), processRow(5, 3, "cmd.exe"), processRow(6, 5, "CODEX.EXE"),
    processRow(7, 0, "ChatGPT.exe"), processRow(8, 7, "codex.exe"), processRow(9, 0, "codex.exe"),
  ]);
  expect(matches.map(item => [item.codex.pid, item.vscode.pid, item.main.pid])).toEqual([[4, 2, 1], [6, 3, 1]]);
});

test("handles missing ancestors, PID reuse and cycles without inventing ownership", () => {
  expect(findCodexProcesses([
    processRow(1, 0, "Code.exe", "2026-10-20T11:00:00Z"), processRow(2, 1, "codex.exe"),
    processRow(3, 999, "codex.exe"), processRow(4, 5, "codex.exe"), processRow(5, 4, "cmd.exe"),
  ])).toEqual([]);
});

test("joins shuffled diagnostics rows by window ID and ignores remote PID collisions", () => {
  const status = parseCodeStatus(`CPU % Mem MB PID Process
  0 100 12 extension-host [2]
  0 100 11 extensionHost [1]
  0 100 21 window [1] (wrong format is ignored)
  0 100 22 window [2] (🍞 Project (dev) - Visual Studio Code)
  0 100 13 extension-host [3]
Workspace Stats:
Remote: SSH: host
  0 100 12 extension-host [9]
  0 100 99 window [9] (remote)
`);
  expect([...status.entries()]).toEqual([[12, { windowId: 2, windowPid: 22, title: "🍞 Project (dev) - Visual Studio Code" }]]);
});

test("extracts quoted and unquoted user-data paths", () => {
  expect(codeUserDataPath({ ...processRow(1, 0, "Code.exe"), commandLine: '--type=utility --user-data-dir="C:\\User Data\\Code" --foo' })).toBe("C:\\User Data\\Code");
  expect(codeUserDataPath({ ...processRow(1, 0, "Code.exe"), commandLine: '--user-data-dir C:\\Code --foo' })).toBe("C:\\Code");
});

test("workspace logs must belong to the latest live host, including creation time", () => {
  const startedAt = new Date(2026, 9, 20, 10, 0, 0).toISOString();
  const host = processRow(42, 1, "Code.exe", startedAt);
  const codexStartedAt = new Date(2026, 9, 20, 10, 2, 0).toISOString();
  const id = "abcdef0123456789abcdef0123456789";
  const block = `2026-10-20 10:00:01.000 [info] Extension host with pid 42 started\n2026-10-20 10:00:01.001 [info] Skipping acquiring lock for C:\\Users\\user\\Code\\User\\workspaceStorage\\${id}.\n`;
  expect(workspaceStorageId(block, host, codexStartedAt)).toBe(id);
  expect(workspaceStorageId(block.replace("10:00:01.000", "10:01:30.000"), host, codexStartedAt)).toBe(id);
  expect(workspaceStorageId(block, { ...host, startedAt: "2030-01-01T00:00:00Z" }, codexStartedAt)).toBeUndefined();
  expect(workspaceStorageId(block, host, "2020-01-01T00:00:00Z")).toBeUndefined();
  expect(workspaceStorageId(block + "2026-10-20 10:00:02.000 [info] Extension host with pid 99 started\n", host, codexStartedAt)).toBeUndefined();
  expect(workspaceStorageId(block + "Extension host with pid 42 exiting with code 0", host, codexStartedAt)).toBeUndefined();
});

test("decodes folder paths, preserves remote URIs and identifies workspace files", () => {
  expect(workspaceLocation({ folder: "file:///d%3A/dev/My%20Project" })).toEqual({ workspace: "d:\\dev\\My Project", workspaceKind: "folder" });
  expect(workspaceLocation({ workspace: "file:///d%3A/dev/project.code-workspace" })).toEqual({ workspace: "d:\\dev\\project.code-workspace", workspaceKind: "workspace" });
  expect(workspaceLocation({ folder: "vscode-remote://ssh-remote%2Bhost/work" }).workspace).toBe("vscode-remote://ssh-remote%2Bhost/work");
  expect(workspaceLocation({ folder: "not a uri" })).toEqual({});
});

test("process helper output is validated before discovery", async () => {
  const runner = jest.fn().mockResolvedValueOnce({ ok: true, result: [{ pid: "42" }] })
    .mockResolvedValueOnce({ ok: true, result: [processRow(1, 0, "Code.exe")] });
  const desktop = new DesktopService({ runner, openUrl: jest.fn() });
  await expect(desktop.listProcesses()).rejects.toThrow("invalid data");
  expect(await desktop.listProcesses()).toEqual([processRow(1, 0, "Code.exe")]);
  desktop.close();
});

test("live workspace metadata remains discoverable behind newer diagnostics-only log directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-codex-metadata-"));
  const log = path.join(root, "logs", "20261019T100000", "window2", "exthost");
  await fs.mkdir(log, { recursive: true });
  for (let index = 10; index < 22; index++) await fs.mkdir(path.join(root, "logs", `20261020T1000${index}`));
  const id = "abcdef0123456789abcdef0123456789";
  const storage = path.join(root, "User", "workspaceStorage", id);
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, "workspace.json"), JSON.stringify({ folder: "file:///d%3A/dev/project" }));
  await fs.writeFile(path.join(log, "exthost.log"), `2026-10-19 10:01:30.000 [info] Extension host with pid 2 started\nSkipping acquiring lock for ${storage}.\n`);
  const rows = [processRow(1, 0, "Code.exe", new Date(2026, 9, 19, 9, 59).toISOString()),
    processRow(2, 1, "Code.exe", new Date(2026, 9, 19, 10, 0).toISOString()),
    processRow(3, 2, "codex.exe", new Date(2026, 9, 19, 10, 2).toISOString())];
  rows[0].executablePath = process.execPath;
  rows[1].commandLine = `--user-data-dir="${root}"`;
  const discovery = new CodexDiscovery({ listProcesses: async () => rows });
  const status = jest.spyOn(discovery as any, "status").mockResolvedValue("0 100 2 extension-host [2]\n0 100 20 window [2] (Project)\n");
  try {
    expect((await discovery.scan()).instances[0]).toMatchObject({ codexPid: 3, vscodePid: 2, title: "Project", workspace: "d:\\dev\\project" });
  } finally { discovery.close(); status.mockRestore(); }
});
