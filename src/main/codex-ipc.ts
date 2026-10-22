import * as net from "net";
import { randomUUID } from "crypto";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export interface CodexIpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  handledByClientId?: string;
  result?: any;
  error?: string;
}

/** Local extension IPC, verified against openai.chatgpt 26.1007.21434.
 * This is a versioned internal protocol, not the app-server stdio protocol.
 * Never create a router, reconnect, or replay a possibly delivered message.
 */
export class CodexIpcClient {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private clientId = "initializing-client";
  private closed = false;
  private pending = new Map<string, { resolve(value: CodexIpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly endpoint = "\\\\.\\pipe\\codex-ipc", private readonly timeoutMs = 15000) {}

  async connect(): Promise<void> {
    if (this.closed || this.socket) throw new Error("Codex connection is already used.");
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = net.createConnection(this.endpoint);
      const timer = setTimeout(() => { reject(new Error("Cannot connect to Codex. Open its conversation and try again.")); this.close(); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.on("error", () => {
        clearTimeout(timer);
        const error = new Error("Codex connection failed. Open its conversation and try again.");
        reject(error); this.fail(error);
      });
      socket.on("close", () => { clearTimeout(timer); reject(new Error("Codex disconnected.")); this.fail(new Error("Codex disconnected; delivery could not be confirmed. Check the conversation before sending again.")); });
      socket.on("data", chunk => this.read(chunk));
    });
    const initialized = await this.request("initialize", { clientType: "tray-platform" }, 0);
    if (initialized.resultType !== "success" || initialized.method !== "initialize" || typeof initialized.result?.clientId !== "string") {
      throw new Error("Codex did not accept the connection.");
    }
    this.clientId = initialized.result.clientId;
  }

  request(method: string, params: unknown, version: number, targetClientId?: string): Promise<CodexIpcResponse> {
    if (this.closed || !this.socket?.writable) return Promise.reject(new Error("Codex is not connected."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Codex did not confirm delivery in time. Check the conversation before sending again."));
        this.close();
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, method, params, version, targetClientId, timeoutMs: this.timeoutMs }); }
      catch { this.fail(new Error("Codex connection failed; delivery could not be confirmed. Check the conversation before sending again.")); }
    });
  }

  close(): void { this.fail(new Error("Codex connection closed.")); }

  private write(message: unknown): void {
    const bytes = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32LE(bytes.length, 0);
    bytes.copy(frame, 4);
    this.socket!.write(frame);
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME_BYTES) throw new Error("Invalid Codex message length.");
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8"));
        this.buffer = this.buffer.subarray(size + 4);
        if (message.type === "client-discovery-request") {
          this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          if (!["success", "error"].includes(message.resultType)) throw new Error("Invalid Codex response.");
          this.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        // No subscription to thread content; unrelated broadcasts are ignored.
      }
    } catch { this.fail(new Error("Codex returned an unreadable response; delivery could not be confirmed. Check the conversation before sending again.")); }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.socket?.destroy();
  }
}
