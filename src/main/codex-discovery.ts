import { ChildProcess, execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { CodexInstance, ProcessDescriptor } from "../shared/codex-instances";
import { CodexScanResult } from "./codex-instance-service";

const isCode = (name: string) => /^(code|code - insiders|vscode)\.exe$/i.test(name);

export interface CodexProcessMatch {
  codex: ProcessDescriptor;
  vscode: ProcessDescriptor;
  main: ProcessDescriptor;
}

/** Walk ancestry rather than assuming the extension host is the immediate parent. */
export function findCodexProcesses(processes: ProcessDescriptor[]): CodexProcessMatch[] {
  const byPid = new Map(processes.map(item => [item.pid, item]));
  const matches: CodexProcessMatch[] = [];
  for (const codex of processes.filter(item => /^codex\.exe$/i.test(item.name))) {
    let child = codex;
    let vscode: ProcessDescriptor | undefined;
    let main: ProcessDescriptor | undefined;
    const seen = new Set([child.pid]);
    while (child.parentPid && !seen.has(child.parentPid)) {
      const parent = byPid.get(child.parentPid);
      // A later-created parent is a recycled PID, not an ancestor.
      if (!parent || Date.parse(parent.startedAt) > Date.parse(child.startedAt)) break;
      seen.add(parent.pid);
      if (isCode(parent.name)) { vscode ||= parent; main = parent; }
      child = parent;
    }
    if (vscode && main) matches.push({ codex, vscode, main });
  }
  return matches;
}

export function parseCodeStatus(output: string): Map<number, { windowId: number; windowPid: number; title: string }> {
  const windows = new Map<number, { windowId: number; windowPid: number; title: string }>();
  const hosts = new Map<number, number>();
  // Remote diagnostics can reuse local PIDs. Only inspect the local process table.
  const local = output.split(/^Workspace Stats:|^Remote:/m)[0];
  for (const line of local.split(/\r?\n/)) {
    const row = /^\s*\d+(?:\.\d+)?\s+\d+\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    const window = /^window \[(\d+)\] \((.*)\)$/.exec(row[2]);
    const host = /^extension[- ]host \[(\d+)\]$/.exec(row[2]);
    if (window) windows.set(Number(window[1]), { windowId: Number(window[1]), windowPid: Number(row[1]), title: window[2] });
    if (host) hosts.set(Number(row[1]), Number(host[1]));
  }
  const result = new Map<number, { windowId: number; windowPid: number; title: string }>();
  hosts.forEach((id, pid) => { const window = windows.get(id); if (window) result.set(pid, window); });
  return result;
}

export function codeUserDataPath(process: ProcessDescriptor): string | undefined {
  const match = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))/.exec(process.commandLine || "");
  return match?.[1] || match?.[2];
}

export function workspaceStorageId(log: string, host: ProcessDescriptor, codexStartedAt: string): string | undefined {
  const starts = [...log.matchAll(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) \[info\] Extension host with pid (\d+) started\r?$/gm)];
  const latest = starts[starts.length - 1];
  if (!latest || Number(latest[2]) !== host.pid || !Number.isFinite(Date.parse(host.startedAt))) return undefined;
  // Hosts can take over a minute to initialize. Their startup log must fall
  // between host creation and Codex creation, not within an arbitrary delay.
  // Logs use local time; process creation timestamps are UTC.
  const loggedAt = new Date(latest[1].replace(" ", "T")).getTime();
  const codexCreated = Date.parse(codexStartedAt);
  if (!Number.isFinite(loggedAt) || !Number.isFinite(codexCreated) ||
    loggedAt < Date.parse(host.startedAt) - 1000 || loggedAt > codexCreated + 1000) return undefined;
  const block = log.slice(latest.index! + latest[0].length);
  if (new RegExp(`Extension host with pid ${host.pid} exiting`).test(block)) return undefined;
  return /workspaceStorage[\\/]([a-f0-9]{32})(?:[\\/.'\s]|$)/i.exec(block)?.[1];
}

export function workspaceLocation(metadata: unknown): Pick<CodexInstance, "workspace" | "workspaceKind"> {
  const item = metadata as { folder?: unknown; workspace?: unknown } | null;
  const uri = item?.folder || item?.workspace;
  if (typeof uri !== "string") return {};
  try {
    const parsed = new URL(uri);
    let location = uri;
    if (parsed.protocol === "file:") {
      location = decodeURIComponent(parsed.pathname);
      if (/^\/[a-z]:\//i.test(location)) location = location.slice(1).replace(/\//g, "\\");
      else if (parsed.hostname) location = `\\\\${parsed.hostname}${location.replace(/\//g, "\\")}`;
    }
    return { workspace: location, workspaceKind: item?.folder ? "folder" : "workspace" };
  } catch { return {}; }
}

async function tail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 512 * 1024));
    const result = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/** Windows discovery only; no Codex RPCs, prompts, or process mutations. */
export class CodexDiscovery {
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  constructor(private readonly desktop: { listProcesses(): Promise<ProcessDescriptor[]> }) {}

  async scan(): Promise<CodexScanResult> {
    if (this.closed) throw new Error("Codex discovery is closed.");
    const matches = findCodexProcesses(await this.desktop.listProcesses());
    const groups = new Map<number, CodexProcessMatch[]>();
    matches.forEach(match => {
      const group = groups.get(match.main.pid) || [];
      group.push(match); groups.set(match.main.pid, group);
    });
    const warnings: string[] = [];
    const instances: CodexInstance[] = [];
    for (const group of groups.values()) {
      if (this.closed) throw new Error("Codex discovery is closed.");
      const { main, vscode } = group[0];
      const userData = codeUserDataPath(vscode) || codeUserDataPath(main);
      let status: ReturnType<typeof parseCodeStatus> = new Map();
      try {
        if (!main.executablePath) throw new Error("VS Code executable path is unavailable");
        status = parseCodeStatus(await this.status(main.executablePath, userData));
      } catch {
        warnings.push(`Window titles unavailable for VS Code PID ${main.pid}.`);
      }
      const logDirectories = await this.logDirectories(userData);
      for (const match of group) {
        const window = status.get(match.vscode.pid);
        const workspace = await this.workspace(userData, logDirectories, match, window?.windowId);
        instances.push({
          codexPid: match.codex.pid, codexStartedAt: match.codex.startedAt,
          vscodePid: match.vscode.pid, vscodeStartedAt: match.vscode.startedAt,
          vscodeMainPid: main.pid, ...window, ...workspace,
        });
      }
    }
    instances.sort((a, b) => (a.title || "").localeCompare(b.title || "") || a.codexPid - b.codexPid);
    return { instances, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
  }

  close(): void {
    this.closed = true;
    this.children.forEach(child => child.kill());
    this.children.clear();
  }

  private status(executable: string, userData?: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Codex discovery is closed."));
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.VSCODE_IPC_HOOK_CLI;
      const child = execFile(executable, ["--status", ...(userData ? ["--user-data-dir", userData] : [])], {
        env, windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
      }, (error, stdout) => {
        this.children.delete(child);
        if (error) reject(new Error("VS Code diagnostics failed or timed out.")); else resolve(stdout);
      });
      this.children.add(child);
    });
  }

  private async logDirectories(userData?: string): Promise<string[]> {
    if (!userData) return [];
    try {
      const root = path.join(userData, "logs");
      return (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && /^\d{8}T\d{6}$/.test(item.name))
        // Diagnostics can create newer, windowless log directories. The live
        // editor's logs may be older than all of those; do not truncate by recency.
        .map(item => item.name).sort().reverse().map(name => path.join(root, name));
    } catch { return []; }
  }

  private async workspace(userData: string | undefined, logs: string[], match: CodexProcessMatch, windowId?: number): Promise<Pick<CodexInstance, "workspace" | "workspaceKind">> {
    if (!userData) return {};
    for (const directory of logs) {
      if (this.closed) return {};
      try {
        const windows = windowId === undefined
          ? (await fs.readdir(directory)).filter(name => /^window\d+$/.test(name)) : [`window${windowId}`];
        for (const window of windows) {
          try {
            const id = workspaceStorageId(await tail(path.join(directory, window, "exthost", "exthost.log")), match.vscode, match.codex.startedAt);
            if (id) return workspaceLocation(JSON.parse(await fs.readFile(path.join(userData, "User", "workspaceStorage", id, "workspace.json"), "utf8")));
          } catch { /* Missing, rotating, or inaccessible metadata is optional. */ }
        }
      } catch { /* A log directory can disappear during a scan. */ }
    }
    return {};
  }
}
