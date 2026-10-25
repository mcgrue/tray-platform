import { ChildProcess, spawn } from "child_process";
import { StringDecoder } from "string_decoder";

export interface CodexRpc {
  request(method: string, params: unknown): Promise<any>;
  close(): void;
}
export interface CodexServerRequestContext {
  requestId: string | number;
  signal: AbortSignal;
  /** Response written to stdio; this does not confirm execution of the operation. */
  responded: Promise<void>;
}

/** One owned stdio runtime. Never reconnect or replay an unacknowledged request. */
export class CodexAppServer implements CodexRpc {
  private child: ChildProcess;
  private nextId = 0;
  private closed = false;
  private buffer = "";
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private ready: Promise<any>;
  private incoming = new Map<string, { params: any; controller: AbortController; reject(error: Error): void }>();

  constructor(executable: string, cwd: string, private readonly options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    notification?(method: string, params: any): void;
    serverRequest?(method: string, params: any, context: CodexServerRequestContext): Promise<unknown>;
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
          for (const [key, entry] of this.incoming) {
            const params = message.params;
            if ((message.method === "serverRequest/resolved" && key === JSON.stringify(params?.requestId) && entry.params?.threadId === params?.threadId) ||
              (message.method === "turn/completed" && entry.params?.threadId === params?.threadId && entry.params?.turnId === params?.turn?.id) ||
              (message.method === "thread/closed" && entry.params?.threadId === params?.threadId)) {
              this.incoming.delete(key); entry.controller.abort(); entry.reject(new Error("Codex approval request expired."));
            }
          }
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
    const key = JSON.stringify(message.id);
    if ((typeof message.id !== "string" && !Number.isSafeInteger(message.id)) || this.incoming.has(key)) {
      this.fail(new Error("Codex sent an invalid or duplicate server request ID.")); return;
    }
    const controller = new AbortController();
    let resolve!: () => void, reject!: (error: Error) => void;
    const responded = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void responded.catch(() => {});
    const incoming = { params: message.params, controller, reject };
    this.incoming.set(key, incoming);
    const send = (payload: unknown) => {
      if (this.closed || controller.signal.aborted) return;
      try {
        this.child.stdin!.write(JSON.stringify(payload) + "\n", error => {
          if (error) { reject(error); this.fail(error); return; }
          if (this.incoming.get(key) !== incoming) return;
          this.incoming.delete(key); resolve();
        });
      } catch (error) { reject(error as Error); this.fail(error as Error); }
    };
    try {
      if (!this.options.serverRequest) throw new Error(`Codex requires interaction: ${message.method}. Open the conversation in Codex.`);
      const result = await this.options.serverRequest(message.method, message.params, { requestId: message.id, signal: controller.signal, responded });
      send({ id: message.id, result });
    } catch (error) {
      send({ id: message.id, error: { code: -32603, message: (error as Error).message } });
    }
  }

  private fail(error: Error, report = true) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.incoming.values()) { entry.controller.abort(); entry.reject(error); }
    this.incoming.clear();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.child.kill();
    if (report) this.options.exited?.(error);
  }
}
