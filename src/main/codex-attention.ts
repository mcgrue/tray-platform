import { AttentionInput, CodexOrigin, NavigationProgress, WindowDestination } from "../shared/attention";
import { CodexInstancesSnapshot, ProcessDescriptor } from "../shared/codex-instances";
import { AttentionError } from "./attention-service";
import { findCodexProcesses } from "./codex-discovery";
import { DesktopService } from "./desktop-service";

const sameStart = (a: string, b: string) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

/** The hook PID is transient. Persist only the verified, long-lived Codex/host pair. */
export function originFromProcess(processes: ProcessDescriptor[], pid: number, observedAt: number): CodexOrigin | undefined {
  const byPid = new Map(processes.map(item => [item.pid, item]));
  const matches = new Map(findCodexProcesses(processes).map(item => [item.codex.pid, item]));
  let current = byPid.get(pid);
  if (!current || !Number.isFinite(Date.parse(current.startedAt)) || Date.parse(current.startedAt) > observedAt) return undefined;
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    const match = matches.get(current.pid);
    if (match && [match.codex, match.vscode, match.main].every(item => Number.isFinite(Date.parse(item.startedAt)))) {
      return { kind: "vscode-codex", codexPid: match.codex.pid, codexStartedAt: match.codex.startedAt,
        vscodePid: match.vscode.pid, vscodeStartedAt: match.vscode.startedAt };
    }
    const parent = byPid.get(current.parentPid);
    if (!parent || !Number.isFinite(Date.parse(parent.startedAt)) || Date.parse(parent.startedAt) > Date.parse(current.startedAt)) break;
    current = parent;
  }
  return undefined;
}

export class CodexAttention {
  constructor(private readonly desktop: Pick<DesktopService, "listProcesses" | "listWindows" | "activate" | "areProcessesRunning">,
    private readonly inventory: { list(): CodexInstancesSnapshot; refresh(): Promise<CodexInstancesSnapshot> }) {}

  async prepareInput(source: string, input: any): Promise<AttentionInput> {
    if (source !== "codex" || input.originProcess === undefined) return input;
    const { originProcess, ...result } = input;
    // Never persist the short-lived caller PID or an unverified suggested origin.
    delete result.origin;
    if (!originProcess || !Number.isSafeInteger(originProcess.pid) || originProcess.pid <= 0 ||
      !Number.isSafeInteger(originProcess.observedAt) || originProcess.observedAt > Date.now() ||
      originProcess.observedAt < Date.now() - 10000) throw new AttentionError("Invalid originating process observation");
    try {
      const origin = originFromProcess(await this.desktop.listProcesses(), originProcess.pid, originProcess.observedAt);
      if (origin) {
        const known = this.inventory.list().instances.find(item => item.codexPid === origin.codexPid &&
          sameStart(item.codexStartedAt, origin.codexStartedAt) && item.vscodePid === origin.vscodePid &&
          sameStart(item.vscodeStartedAt, origin.vscodeStartedAt));
        result.origin = { ...origin, ...(known?.title ? { title: known.title } : {}) };
      }
    } catch { /* Optional discovery must not prevent delivery of the question. */ }
    return result;
  }

  async activate(item: AttentionInput, progress: (update: NavigationProgress) => void = () => {}): Promise<void> {
    // An explicitly chosen destination always wins over automatic navigation.
    if (item.destination) {
      const destination = item.destination.kind === "url" ? item.destination.url : item.destination.title;
      progress({ phase: "activating", destination });
      await this.desktop.activate(item.destination);
      progress({ phase: "opened", destination });
      return;
    }
    if (!item.origin) throw new Error("Choose a destination in the inbox first.");
    const origin = item.origin;
    const findInstance = (snapshot: CodexInstancesSnapshot) => snapshot.instances.find(entry => entry.codexPid === origin.codexPid &&
      sameStart(entry.codexStartedAt, origin.codexStartedAt) && entry.vscodePid === origin.vscodePid &&
      sameStart(entry.vscodeStartedAt, origin.vscodeStartedAt));
    const cached = this.inventory.list();
    if (!cached.supported) throw new Error("VS Code window discovery is unavailable.");
    let instance = findInstance(cached);
    if (!instance) throw new Error("The originating process is not in the cached mapping. Refresh Codex Instances and try Go again.");
    const identities = [{ pid: origin.codexPid, startedAt: origin.codexStartedAt },
      { pid: origin.vscodePid, startedAt: origin.vscodeStartedAt }];
    // A targeted identity check avoids the expensive VS Code inventory scan.
    // A reused PID means the original mapped process no longer exists.
    if (!await this.desktop.areProcessesRunning(identities)) {
      progress({ phase: "scanning" });
      const refreshed = await this.inventory.refresh();
      if (!refreshed.supported || refreshed.error) throw new Error("Cannot refresh VS Code windows. Try again or choose a destination manually.");
      instance = findInstance(refreshed);
      if (!instance) throw new Error("The originating Codex or VS Code process has exited or changed. Choose a destination manually.");
    }
    if (!instance.title) throw new Error("The originating VS Code window title is unavailable. Refresh Codex Instances and try Go again.");
    const windows: WindowDestination[] = (await this.desktop.listWindows()).filter(window =>
      window.pid === instance.vscodeMainPid && window.title === instance.title);
    if (windows.length !== 1) throw new Error(windows.length
      ? "Several VS Code windows have this title. Choose the destination manually."
      : "The originating VS Code window has closed or changed title. Refresh Codex Instances and try Go again.");
    progress({ phase: "activating", destination: instance.title });
    await this.desktop.activate(windows[0], { title: instance.title, processes: identities });
    progress({ phase: "opened", destination: instance.title });
  }
}
