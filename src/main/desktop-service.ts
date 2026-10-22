import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { Destination, WindowDestination } from "../shared/attention";
import { ProcessDescriptor } from "../shared/codex-instances";

export interface DesktopRequest {
  command: "list" | "foreground" | "activate" | "processes";
  appPid: number;
  destination?: WindowDestination;
  guard?: WindowActivationGuard;
}

export interface WindowActivationGuard {
  title: string;
  processes: Array<{ pid: number; startedAt: string }>;
}

export interface DesktopServiceOptions {
  openUrl: (url: string) => Promise<unknown>;
  appPid?: number;
  helperPath?: string;
  runner?: (request: DesktopRequest) => Promise<unknown>;
  timeoutMs?: number;
}

export function isWindowDestination(value: unknown): value is WindowDestination {
  const item = value as WindowDestination;
  return !!item && item.kind === "window" && typeof item.hwnd === "string" &&
    /^[1-9]\d{0,18}$/.test(item.hwnd) && Number.isSafeInteger(item.pid) && item.pid > 0 &&
    typeof item.processStartedAt === "string" && item.processStartedAt.length <= 64 &&
    Number.isFinite(Date.parse(item.processStartedAt)) &&
    (item.title === undefined || typeof item.title === "string");
}

/** Read-only discovery plus explicit window navigation/capture requests. */
export class DesktopService {
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  private readonly appPid: number;

  constructor(private readonly options: DesktopServiceOptions) {
    this.appPid = options.appPid || process.pid;
  }

  async listWindows(): Promise<WindowDestination[]> {
    const result = await this.request("list");
    if (!Array.isArray(result) || !result.every(isWindowDestination)) {
      throw new Error("Window discovery returned invalid data. Try again.");
    }
    return result.filter(item => item.pid !== this.appPid);
  }

  async listProcesses(): Promise<ProcessDescriptor[]> {
    const result = await this.request("processes");
    if (!Array.isArray(result) || !result.every(item => item &&
      Number.isSafeInteger(item.pid) && item.pid >= 0 &&
      Number.isSafeInteger(item.parentPid) && item.parentPid >= 0 &&
      typeof item.name === "string" && typeof item.startedAt === "string" &&
      (item.executablePath === undefined || typeof item.executablePath === "string") &&
      (item.commandLine === undefined || typeof item.commandLine === "string"))) {
      throw new Error("Process discovery returned invalid data.");
    }
    return result;
  }

  async captureForeground(): Promise<WindowDestination | undefined> {
    const result = await this.request("foreground");
    if (result === null || result === undefined) return undefined;
    if (!isWindowDestination(result)) throw new Error("Foreground window capture returned invalid data.");
    return result.pid === this.appPid ? undefined : result;
  }

  async activate(destination: Destination, guard?: WindowActivationGuard): Promise<void> {
    if (this.closed) throw new Error("Desktop service is closed.");
    if (destination?.kind === "url") {
      let url: URL;
      try { url = new URL(destination.url); }
      catch { throw new Error("Destination must be a valid HTTP(S) URL."); }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP(S) links can be opened.");
      }
      await this.options.openUrl(url.href);
      return;
    }
    if (!isWindowDestination(destination)) throw new Error("Choose a valid window destination.");
    if (destination.pid === this.appPid) throw new Error("Choose a window outside Tray Platform.");
    await this.request("activate", destination, guard);
  }

  close(): void {
    this.closed = true;
    this.children.forEach(child => child.kill());
    this.children.clear();
  }

  private async request(command: DesktopRequest["command"], destination?: WindowDestination, guard?: WindowActivationGuard): Promise<unknown> {
    if (this.closed) throw new Error("Desktop service is closed.");
    const request: DesktopRequest = { command, appPid: this.appPid };
    if (destination) request.destination = destination;
    if (guard) request.guard = guard;
    const response = await (this.options.runner ? this.options.runner(request) : this.runHelper(request));
    if (!response || typeof response !== "object" || typeof (response as any).ok !== "boolean") {
      throw new Error("Windows helper returned invalid data.");
    }
    if (!(response as any).ok) {
      throw new Error(typeof (response as any).error === "string" ? (response as any).error : "Windows operation failed.");
    }
    return (response as any).result;
  }

  private runHelper(request: DesktopRequest): Promise<unknown> {
    if (process.platform !== "win32") return Promise.reject(new Error("Window destinations require Windows."));
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const helper = this.options.helperPath || path.join(__dirname, "resources", "desktop-helper.ps1");
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      let output = "";
      let errorOutput = "";
      let finished = false;
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error("Windows helper timed out. Try again or select another window."));
        child.kill();
      }, this.options.timeoutMs || 10000);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 1024 * 1024) {
          finish(new Error("Windows helper output exceeded its limit."));
          child.kill();
        }
      });
      child.stderr!.on("data", (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-4096); });
      child.once("error", error => finish(new Error(`Cannot start Windows helper: ${error.message}`)));
      child.stdin!.on("error", error => finish(new Error(`Cannot send Windows request: ${error.message}`)));
      child.once("close", code => {
        if (this.closed) return finish(new Error("Desktop service is closed."));
        if (code !== 0) return finish(new Error(`Windows helper failed (${code}): ${errorOutput.trim() || "check helper installation"}`));
        try { finish(undefined, JSON.parse(output.replace(/^\uFEFF/, "").trim())); }
        catch { finish(new Error("Windows helper returned unreadable data.")); }
      });
      child.stdin!.end(JSON.stringify(request));
    });
  }
}
