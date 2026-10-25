import { promises as fs } from "fs";
import path from "path";
import { CodexInstance, CodexInstanceConversation, ProcessDescriptor } from "../shared/codex-instances";
import { CodexMessageReceipt, isCodexSessionId } from "../shared/codex-message";
import { CodexAppServer, CodexRpc, CodexServerRequestContext } from "./codex-app-server";
import { findCodexProcesses } from "./codex-discovery";
import { CodexMessage, codexMessageParts, validateCodexMessage } from "./codex-attachments";

const identity = (instance: CodexInstance) => JSON.stringify([instance.codexPid, instance.codexStartedAt]);
const normalized = (value: string) => value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
interface Runtime { client: CodexRpc; cwd: string; instance: CodexInstance; sessions: Set<string>; turns: Map<string, string>; output: Map<string, Map<string, string>>; }

/** Saved project history and sessions owned by Tray, independent of recent execution logs. */
export class CodexProjectSessions {
  private runtimes = new Map<string, Promise<Runtime>>();
  private sessions = new Map<string, Runtime>();
  private sending = new Set<string>();
  private closed = false;
  constructor(private readonly options: {
    processes(): Promise<ProcessDescriptor[]>;
    createClient?: (executable: string, cwd: string, callbacks: {
      notification(method: string, params: any): void;
      serverRequest(method: string, params: any, context: CodexServerRequestContext): Promise<unknown>;
      exited(error: Error): void;
    }) => CodexRpc;
    completed?(instance: CodexInstance, sessionId: string, turnId: string, text: string, status: string): void;
    interaction?(instance: CodexInstance, method: string, params: any, context: CodexServerRequestContext, proposedItem?: unknown): Promise<unknown>;
  }) {}

  owns(sessionId: string) { return this.sessions.has(sessionId); }

  async conversations(instance: CodexInstance): Promise<CodexInstanceConversation[]> {
    const runtime = await this.runtime(instance);
    const rows: CodexInstanceConversation[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const result: any = await runtime.client.request("thread/list", { cwd: runtime.cwd, cursor, limit: 100,
        sortKey: "updated_at", archived: false, sourceKinds: ["cli", "vscode", "exec", "appServer"], useStateDbOnly: true });
      if (!Array.isArray(result?.data)) throw new Error("Codex returned invalid project history.");
      for (const thread of result.data) {
        if (!isCodexSessionId(thread?.id) || typeof thread.cwd !== "string" || normalized(thread.cwd) !== normalized(runtime.cwd)) continue;
        rows.push({ id: thread.id, title: String(thread.name || thread.preview || `Conversation ${thread.id}`).slice(0, 240),
          lastActiveAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt * 1000 : 0 });
      }
      cursor = result.nextCursor || null;
      if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated history page.");
      if (cursor) seen.add(cursor);
      if (rows.length >= 1000) break;
    } while (cursor);
    return rows;
  }

  async send(instance: CodexInstance, sessionId: string, message: CodexMessage): Promise<CodexMessageReceipt> {
    validateCodexMessage(message);
    const lock = sessionId || identity(instance);
    if (this.sending.has(lock)) throw new Error("A message is already being sent to this Codex conversation.");
    this.sending.add(lock);
    try {
      const runtime = this.sessions.get(sessionId) || await this.runtime(instance);
      if (!instance.workspace || normalized(await fs.realpath(instance.workspace)) !== normalized(runtime.cwd)) {
        throw new Error("This conversation belongs to another project. Refresh conversations.");
      }
      if (!sessionId) {
        const result = await runtime.client.request("thread/start", { cwd: runtime.cwd });
        sessionId = result?.thread?.id;
        if (!isCodexSessionId(sessionId)) throw new Error("Codex did not confirm the new conversation.");
        this.sessions.set(sessionId, runtime); runtime.sessions.add(sessionId);
      } else if (!runtime.sessions.has(sessionId)) {
        // Recheck persisted membership immediately before resuming; renderer IDs are untrusted.
        const read = await runtime.client.request("thread/read", { threadId: sessionId, includeTurns: false });
        if (typeof read?.thread?.cwd !== "string" || normalized(read.thread.cwd) !== normalized(runtime.cwd)) {
          throw new Error("This conversation belongs to another project. Refresh conversations.");
        }
        await runtime.client.request("thread/resume", { threadId: sessionId, cwd: runtime.cwd });
        this.sessions.set(sessionId, runtime); runtime.sessions.add(sessionId);
      }
      return await this.deliver(runtime, sessionId, message);
    } finally { this.sending.delete(lock); }
  }

  async sendExisting(sessionId: string, message: CodexMessage): Promise<CodexMessageReceipt> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error("This project conversation is no longer running in Tray Platform.");
    return this.send(runtime.instance, sessionId, message);
  }

  close() {
    this.closed = true;
    for (const runtime of this.runtimes.values()) void runtime.then(row => row.client.close(), () => {});
    this.runtimes.clear(); this.sessions.clear();
  }

  private async deliver(runtime: Runtime, sessionId: string, message: CodexMessage): Promise<CodexMessageReceipt> {
    const { input } = codexMessageParts(message);
    const active = runtime.turns.get(sessionId);
    if (active) {
      const result = await runtime.client.request("turn/steer", { threadId: sessionId, input, expectedTurnId: active });
      if (typeof result?.turnId !== "string") throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
      return { sessionId, turnId: result.turnId, delivery: "steered" };
    }
    const result = await runtime.client.request("turn/start", { threadId: sessionId, input });
    if (typeof result?.turn?.id !== "string") throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
    return { sessionId, turnId: result.turn.id, delivery: "started" };
  }

  private runtime(instance: CodexInstance): Promise<Runtime> {
    if (this.closed) return Promise.reject(new Error("Codex project messaging is closed."));
    const key = identity(instance);
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = this.start(instance);
      this.runtimes.set(key, runtime);
      void runtime.catch(() => { if (this.runtimes.get(key) === runtime) this.runtimes.delete(key); });
    }
    return runtime;
  }

  private async start(instance: CodexInstance): Promise<Runtime> {
    const match = findCodexProcesses(await this.options.processes()).find(row => row.codex.pid === instance.codexPid &&
      row.codex.startedAt === instance.codexStartedAt && row.vscode.pid === instance.vscodePid && row.vscode.startedAt === instance.vscodeStartedAt);
    if (!match?.codex.executablePath || !instance.workspace || instance.workspaceKind === "workspace" || !path.isAbsolute(instance.workspace)) {
      throw new Error("Cannot start Codex for this instance. A running local Codex and a project folder are required.");
    }
    const cwd = await fs.realpath(instance.workspace);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("The project folder is unavailable.");
    if (this.closed) throw new Error("Codex project messaging is closed.");
    const runtime: Runtime = { client: undefined as any, cwd, instance, sessions: new Set(), turns: new Map(), output: new Map() };
    const proposed = new Map<string, any>();
    const itemKey = (threadId: string, turnId: string, itemId: string) => JSON.stringify([threadId, turnId, itemId]);
    const callbacks = {
      notification: (method: string, params: any) => {
        const id = params?.threadId;
        if (method === "item/started" && ["commandExecution", "fileChange"].includes(params.item?.type)) {
          const key = itemKey(id, params.turnId, params.item.id);
          // An absent proposal disables Allow once; never retain an incomplete diff as complete.
          proposed.delete(key);
          if (JSON.stringify(params.item).length <= 180000) proposed.set(key, params.item);
          while (proposed.size > 128) proposed.delete(proposed.keys().next().value!);
        }
        if (method === "item/completed") proposed.delete(itemKey(id, params.turnId, params.item?.id));
        if (method === "thread/closed") for (const key of proposed.keys()) if (JSON.parse(key)[0] === id) proposed.delete(key);
        if (method === "turn/started") { runtime.turns.set(id, params.turn.id); runtime.output.set(id, new Map()); }
        if (method === "item/agentMessage/delta" || (method === "item/completed" && params.item?.type === "agentMessage")) {
          const messages = runtime.output.get(id) || new Map<string, string>();
          const itemId = params.itemId || params.item?.id || "message";
          messages.set(itemId, method === "item/completed" ? String(params.item.text || "").slice(-18000)
            : ((messages.get(itemId) || "") + String(params.delta || "")).slice(-18000));
          while (messages.size > 64) messages.delete(messages.keys().next().value!);
          runtime.output.set(id, messages);
        }
        if (method === "turn/completed") {
          for (const key of proposed.keys()) if (JSON.parse(key)[0] === id && JSON.parse(key)[1] === params.turn.id) proposed.delete(key);
          if (runtime.turns.get(id) === params.turn.id) runtime.turns.delete(id);
          const text = [...(runtime.output.get(id)?.values() || [])].join("\n\n").slice(-18000) || params.turn.error?.message || "Codex finished without a text response.";
          runtime.output.delete(id);
          this.options.completed?.(instance, id, params.turn.id, text, params.turn.status);
        }
      },
      serverRequest: async (method: string, params: any, context: CodexServerRequestContext) => {
        if (this.options.interaction) return this.options.interaction(instance, method, params, context,
          proposed.get(itemKey(params?.threadId, params?.turnId, params?.itemId)));
        throw new Error(`Open this conversation in Codex to handle ${method}.`);
      },
      exited: (error: Error) => {
        this.runtimes.delete(identity(instance));
        for (const id of runtime.sessions) this.sessions.delete(id);
        for (const [id, turn] of runtime.turns) this.options.completed?.(instance, id, turn, error.message, "failed");
      },
    };
    runtime.client = this.options.createClient?.(match.codex.executablePath, cwd, callbacks) || new CodexAppServer(match.codex.executablePath, cwd, callbacks);
    return runtime;
  }
}
