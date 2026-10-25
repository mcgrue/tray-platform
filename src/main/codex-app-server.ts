import { ChildProcess, spawn } from "child_process";
import { StringDecoder } from "string_decoder";

export interface CodexRpc {
  request(method: string, params: unknown): Promise<any>;
  close(): void;
}

/** One owned stdio runtime. Never reconnect or replay an unacknowledged request. */
export class CodexAppServer implements CodexRpc {
  private child: ChildProcess;
  private nextId = 0;
  private closed = false;
  private buffer = "";
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private ready: Promise<any>;

  constructor(executable: string, cwd: string, private readonly options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    notification?(method: string, params: any): void;
    serverRequest?(method: string, params: any): Promise<unknown>;
    exited?(error: Error): void;
  } = {}) {
    const env = { ...(options.env || process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(executable, ["app-server", "--stdio"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    this.child.stdout!.on("data", bytes => this.read(decoder.write(bytes)));
    this.child.stderr!.resume();
    this.child.stdin!.on("error", () => this.fail(new Error("Codex disconnected; delivery could not be confirmed. Check the conversation before sending again.")));
    this.child.on("error", error => this.fail(new Error(`Cannot start Codex: ${error.message}`)));
    this.child.on("close", () => this.fail(new Error("Codex exited; delivery could not be confirmed. Check the conversation before sending again.")));
    this.ready = this.call("initialize", { clientInfo: { name: "tray_platform", title: "Tray Platform", version: "1.0.0" },
      capabilities: { experimentalApi: true } }).then(() => this.write({ method: "initialized", params: {} }));
    // Initialization can fail before the caller has made its first request.
    void this.ready.catch(() => {});
  }

  async request(method: string, params: unknown): Promise<any> { await this.ready; return this.call(method, params); }
  close() { this.fail(new Error("Codex project runtime closed."), false); }

  private call(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex project runtime is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Codex did not confirm delivery in time. Check the conversation before sending again.")), this.options.timeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.fail(error as Error); }
    });
  }

  private write(value: unknown) {
    if (this.closed) throw new Error("Codex project runtime is closed.");
    this.child.stdin!.write(JSON.stringify(value) + "\n");
  }

  private read(text: string) {
    if (this.closed) return;
    this.buffer += text;
    if (this.buffer.length > 32 * 1024 * 1024) return this.fail(new Error("Codex response exceeded its limit."));
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          void this.reply(message);
        } else if (message.method) {
          this.options.notification?.(message.method, message.params);
        } else {
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          this.pending.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error(message.error.message || "Codex rejected the request."));
          else entry.resolve(message.result);
        }
      } catch { this.fail(new Error("Codex returned an unreadable response. Check the conversation before sending again.")); return; }
    }
  }

  private async reply(message: any) {
    try {
      if (!this.options.serverRequest) throw new Error(`Codex requires interaction: ${message.method}. Open the conversation in Codex.`);
      const result = await this.options.serverRequest(message.method, message.params);
      if (!this.closed) this.write({ id: message.id, result });
    } catch (error) {
      if (!this.closed) this.write({ id: message.id, error: { code: -32603, message: (error as Error).message } });
    }
  }

  private fail(error: Error, report = true) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.child.kill();
    if (report) this.options.exited?.(error);
  }
}
