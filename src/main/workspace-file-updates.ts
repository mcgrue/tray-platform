import { ChildProcess, spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { CodexInstance } from "../shared/codex-instances";

export interface CodexTurnOwner {
  processIdentity: string;
  threadId: string;
  turnId: string;
  firstObservedAt: number;
  lastObservedAt: number;
  rolloutPath: string;
}
export interface CodexEdit { turnId: string; updatedAt: number; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only explicit, successful edit events count; tool text and file mtimes do not. */
export function recordedCodexEdits(text: string, threadId?: string): CodexEdit[] {
  const latest = new Map<string, number>();
  for (const line of text.split("\n")) {
    try {
      const record = JSON.parse(line);
      const event = record.payload;
      const legacy = event?.type === "patch_apply_end" && event.success === true && event.status === "completed";
      const current = event?.type === "item_completed" && event.item?.type === "FileChange" && event.item.status === "completed";
      const changes = legacy ? event.changes : current ? event.item.changes : undefined;
      const timestamp = current && Number.isFinite(event.completed_at_ms) ? event.completed_at_ms : Date.parse(record.timestamp);
      if (record.type !== "event_msg" || (!legacy && !current) || !uuid.test(event.turn_id) ||
        (threadId && event.thread_id && event.thread_id !== threadId) ||
        !changes || typeof changes !== "object" || !Object.keys(changes).length || !Number.isFinite(timestamp)) continue;
      latest.set(event.turn_id, Math.max(latest.get(event.turn_id) ?? timestamp, timestamp));
    } catch { /* Ignore incomplete, rotating or unrecognized records. */ }
  }
  return [...latest].map(([turnId, updatedAt]) => ({ turnId, updatedAt }));
}

export class CodexFileUpdates {
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  private readonly codexHome: string;
  private readonly cache = new Map<string, { size: number; mtime: number; edits: CodexEdit[] }>();

  constructor(private readonly options: {
    codexHome?: string;
    helperPath?: string;
    timeoutMs?: number;
    now?: () => number;
    readOwners?: (sinceSeconds: number) => Promise<unknown>;
  } = {}) {
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  }

  async enrich(instances: CodexInstance[]): Promise<void> {
    instances.forEach(instance => { delete instance.lastFileUpdatedAt; });
    const active = instances.filter(instance => Number.isSafeInteger(instance.codexPid) && instance.codexPid > 0 &&
      Number.isFinite(Date.parse(instance.codexStartedAt)));
    if (this.closed || !active.length) return;
    const now = (this.options.now || Date.now)();
    const deadline = Date.now() + 10000;
    const since = Math.floor(Math.min(...active.map(item => Date.parse(item.codexStartedAt))) / 1000);
    try {
      const response = await (this.options.readOwners ? this.options.readOwners(since) : this.readOwners(since));
      if (!Array.isArray(response) || !response.every(isTurnOwner)) return;
      const turns = new Map<string, CodexTurnOwner[]>();
      for (const owner of response) {
        const key = owner.threadId + ":" + owner.turnId;
        const owners = turns.get(key) || [];
        owners.push(owner); turns.set(key, owners);
      }
      const files = new Map<string, Promise<CodexEdit[]>>();
      const usedFiles = new Set<string>();
      // A turn observed under multiple process identities is ambiguous after takeover.
      for (const owners of turns.values()) {
        if (this.closed) return;
        if (Date.now() >= deadline || files.size > 128) throw new Error("Codex edit history scan limit reached.");
        if (new Set(owners.map(owner => owner.processIdentity)).size !== 1) continue;
        const owner = owners[0];
        const pid = Number(/^pid:(\d+):/.exec(owner.processIdentity)![1]);
        const instance = active.find(item => item.codexPid === pid);
        if (!instance || owner.firstObservedAt < Date.parse(instance.codexStartedAt) ||
          owner.firstObservedAt > now || !this.isSessionPath(owner.rolloutPath)) continue;
        const key = owner.threadId + ":" + owner.rolloutPath;
        usedFiles.add(key);
        if (!files.has(key)) files.set(key, this.readEdits(owner.rolloutPath, owner.threadId, key));
        const edits = await files.get(key)!;
        if (this.closed) return;
        for (const edit of edits) {
          if (edit.turnId !== owner.turnId || edit.updatedAt < owner.firstObservedAt || edit.updatedAt > now) continue;
          instance.lastFileUpdatedAt = Math.max(instance.lastFileUpdatedAt ?? edit.updatedAt, edit.updatedAt);
        }
      }
      for (const key of this.cache.keys()) if (!usedFiles.has(key)) this.cache.delete(key);
    } catch {
      // Missing or changed Codex internals leave this optional column unavailable.
      instances.forEach(instance => { delete instance.lastFileUpdatedAt; });
    }
  }

  close(): void {
    this.closed = true;
    this.children.forEach(child => child.kill());
    this.children.clear();
    this.cache.clear();
  }

  private isSessionPath(file: string): boolean {
    return ["sessions", "archived_sessions"].some(directory => {
      // Codex stores both ordinary and extended-length Windows paths.
      const relative = path.relative(path.toNamespacedPath(path.join(this.codexHome, directory)), path.toNamespacedPath(file));
      return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) && file.endsWith(".jsonl");
    });
  }

  private async readEdits(file: string, threadId: string, key: string): Promise<CodexEdit[]> {
    try {
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        const cached = this.cache.get(key);
        if (cached?.size === stat.size && cached.mtime === stat.mtimeMs) return cached.edits;
        const head = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        const first = await handle.read(head, 0, head.length, 0);
        const metadata = JSON.parse(head.subarray(0, first.bytesRead).toString("utf8").split("\n")[0]);
        if (metadata.type !== "session_meta" || metadata.payload?.id !== threadId) return [];
        const buffer = Buffer.alloc(Math.min(stat.size, 16 * 1024 * 1024));
        const offset = stat.size - buffer.length;
        const result = await handle.read(buffer, 0, buffer.length, offset);
        let text = buffer.subarray(0, result.bytesRead).toString("utf8");
        if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
        const edits = recordedCodexEdits(text, threadId);
        // Keep known edits when a growing transcript pushes them outside its tail.
        if (cached && stat.size >= cached.size) {
          for (const previous of cached.edits) {
            const current = edits.find(edit => edit.turnId === previous.turnId);
            if (!current) edits.push(previous);
            else current.updatedAt = Math.max(current.updatedAt, previous.updatedAt);
          }
        }
        this.cache.set(key, { size: stat.size, mtime: stat.mtimeMs, edits });
        return edits;
      } finally { await handle.close(); }
    } catch { return []; }
  }

  private readOwners(sinceSeconds: number): Promise<unknown> {
    if (process.platform !== "win32" || this.closed) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const helper = this.options.helperPath || path.join(__dirname, "resources", "codex-file-updates.ps1");
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      let output = "", settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.children.delete(child);
        if (error) { child.kill(); reject(error); } else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Codex activity scan timed out.")), this.options.timeoutMs ?? 10000);
      child.on("error", error => finish(error));
      child.stdin.on("error", error => finish(error));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        output += chunk;
        if (output.length > 8 * 1024 * 1024) finish(new Error("Codex activity output is too large."));
      });
      child.stderr.resume();
      child.on("close", code => {
        try {
          const response = JSON.parse(output);
          if (code !== 0 || response?.ok !== true) throw new Error("Codex edit history is unavailable.");
          finish(undefined, response.result);
        } catch { finish(new Error("Codex edit history is unavailable.")); }
      });
      child.stdin.end(JSON.stringify({ codexHome: this.codexHome, sinceSeconds }));
    });
  }
}

function isTurnOwner(value: any): value is CodexTurnOwner {
  return value && typeof value.processIdentity === "string" &&
    /^pid:[1-9]\d*:[0-9a-f-]{36}$/i.test(value.processIdentity) && uuid.test(value.threadId) && uuid.test(value.turnId) &&
    typeof value.rolloutPath === "string" && Number.isFinite(value.firstObservedAt) &&
    Number.isFinite(value.lastObservedAt) && value.firstObservedAt <= value.lastObservedAt;
}
