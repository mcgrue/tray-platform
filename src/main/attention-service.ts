import { promises as fs } from "fs";
import path = require("path");
import { randomBytes } from "crypto";
import { AttentionInput, AttentionItem, AttentionSnapshot, AttentionState, CodexOrigin, Destination } from "../shared/attention";
import { isCodexSessionId } from "../shared/codex-message";
import { CODEX_APPROVAL_SOURCE, CodexApproval, pendingApproval } from "../shared/codex-approval";

const sounds = new Set<string>(Object.values(require("../shared/sounds.json").sounds).map((sound: any) => sound.id));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class AttentionError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttentionError("Expected a JSON object");
  return value as Record<string, any>;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new AttentionError(`Invalid ${name}`);
  return value;
}

export function validateAttentionIdentity(source: unknown, id: unknown): void {
  text(source, "source", 200);
  text(id, "id", 200);
}

export function validateDestination(value: unknown): Destination {
  const destination = object(value);
  if (destination.kind === "url") {
    const url = text(destination.url, "destination URL", 8192);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new AttentionError("Invalid destination URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new AttentionError("Destination must use HTTP or HTTPS");
    return { kind: "url", url };
  }
  if (destination.kind === "window") {
    const hwnd = text(destination.hwnd, "window handle", 32);
    if (!/^[1-9]\d{0,18}$/.test(hwnd)) throw new AttentionError("Invalid window handle");
    if (!Number.isSafeInteger(destination.pid) || destination.pid <= 0) throw new AttentionError("Invalid window process ID");
    const processStartedAt = text(destination.processStartedAt, "process start time", 100);
    if (!Number.isFinite(Date.parse(processStartedAt))) throw new AttentionError("Invalid process start time");
    if (destination.title !== undefined && (typeof destination.title !== "string" || destination.title.length > 2000)) throw new AttentionError("Invalid window title");
    return { kind: "window", hwnd, pid: destination.pid, processStartedAt, ...(destination.title === undefined ? {} : { title: destination.title }) };
  }
  throw new AttentionError("Invalid destination kind");
}

export function validateCodexOrigin(value: unknown): CodexOrigin {
  const origin = object(value);
  if (origin.kind !== "vscode-codex") throw new AttentionError("Invalid attention origin");
  for (const key of ["codexPid", "vscodePid"]) {
    if (!Number.isSafeInteger(origin[key]) || origin[key] <= 0) throw new AttentionError("Invalid origin process ID");
  }
  for (const key of ["codexStartedAt", "vscodeStartedAt"]) {
    if (!Number.isFinite(Date.parse(text(origin[key], "origin process start time", 100)))) throw new AttentionError("Invalid origin process start time");
  }
  return { kind: "vscode-codex", codexPid: origin.codexPid, codexStartedAt: origin.codexStartedAt,
    vscodePid: origin.vscodePid, vscodeStartedAt: origin.vscodeStartedAt,
    ...(origin.title === undefined ? {} : { title: text(origin.title, "origin window title", 2000) }) };
}

export function validateAttentionInput(value: unknown): AttentionInput {
  const input = object(value);
  const result: AttentionInput = { title: text(input.title, "title", 500) };
  if (input.codexSessionId !== undefined) {
    if (!isCodexSessionId(input.codexSessionId)) throw new AttentionError("Invalid Codex session ID");
    result.codexSessionId = input.codexSessionId;
  }
  for (const [key, maximum] of [["description", 20000], ["project", 500]] as const) {
    if (input[key] !== undefined) result[key] = text(input[key], key, maximum);
  }
  if (input.destination !== undefined) result.destination = validateDestination(input.destination);
  if (input.origin !== undefined) result.origin = validateCodexOrigin(input.origin);
  if (input.approval !== undefined) result.approval = validateApproval(input.approval);
  if (input.sound !== undefined) {
    if (!sounds.has(input.sound)) throw new AttentionError("Unknown sound ID");
    result.sound = input.sound;
  }
  return result;
}

function validateApproval(value: unknown): CodexApproval {
  const approval = object(value);
  if (!["command", "file", "network"].includes(approval.kind) ||
    !["pending", "sending", "allowed", "declined", "expired", "unknown"].includes(approval.status) ||
    typeof approval.canAllow !== "boolean" || typeof approval.canDecline !== "boolean") throw new AttentionError("Invalid approval");
  return { kind: approval.kind, status: approval.status, canAllow: approval.canAllow, canDecline: approval.canDecline,
    threadId: text(approval.threadId, "approval conversation", 200), turnId: text(approval.turnId, "approval turn", 200),
    itemId: text(approval.itemId, "approval item", 200), details: text(approval.details, "approval details", 200000),
    ...(approval.notice ? { notice: text(approval.notice, "approval notice", 2000) } : {}) };
}

function validateStore(value: unknown): { items: AttentionItem[]; migrated: boolean } {
  const store = object(value);
  if (store.version !== 1 && store.version !== 2) throw new Error("Unsupported attention store version");
  if (!Array.isArray(store.items)) throw new Error("Invalid attention store items");
  const identities = new Set<string>();
  const items = store.items.map((value: unknown) => {
    const item = object(value);
    validateAttentionIdentity(item.source, item.id);
    const identity = JSON.stringify([item.source, item.id]);
    if (identities.has(identity)) throw new Error("Duplicate attention identity");
    identities.add(identity);
    // Upgrade legacy deferred items once; no timers or deferred state remain at runtime.
    const state = store.version === 1 && item.state === "snoozed" ? "pending" : item.state;
    if (!["pending", "done"].includes(state)) throw new Error("Invalid attention state");
    if (![item.createdAt, item.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0)) throw new Error("Invalid attention timestamps");
    return { ...validateAttentionInput(item), source: item.source, id: item.id, state, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  return { items, migrated: store.version === 1 };
}

export class AttentionService {
  private items: AttentionItem[] = [];
  private error?: string;
  private initialized = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: AttentionSnapshot) => void>();
  private readonly now: () => number;

  constructor(private readonly filePath: string, private readonly options: { now?: () => number; onSound?: (id: string) => void } = {}) {
    this.now = options.now || Date.now;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      let raw: string;
      try { raw = await fs.readFile(this.filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.initialized = true; return; } throw error; }
      const { items, migrated } = validateStore(JSON.parse(raw));
      if (migrated) await this.persist(items);
      this.items = items;
    } catch (error) {
      this.error = `Attention store is read-only; existing file preserved: ${(error as Error).message}`;
    }
    this.initialized = true;
  }

  list(): AttentionSnapshot {
    return { items: clone(this.items).sort((a, b) => b.createdAt - a.createdAt), ...(this.error ? { error: this.error } : {}) };
  }

  get(source: string, id: string): AttentionItem | undefined {
    const item = this.items.find(item => item.source === source && item.id === id);
    return item ? clone(item) : undefined;
  }

  onChanged(callback: (snapshot: AttentionSnapshot) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  upsert(source: string, id: string, input: AttentionInput, options: { createOnly?: boolean } = {}): Promise<AttentionItem> {
    return this.mutate(async items => {
      validateAttentionIdentity(source, id);
      const data = validateAttentionInput(input);
      const index = items.findIndex(item => item.source === source && item.id === id);
      const previous = items[index];
      if (previous && options.createOnly) throw new AttentionError("Attention item already exists", 412);
      const now = this.now();
      const item: AttentionItem = { ...data, source, id, state: previous ? previous.state : "pending", createdAt: previous ? previous.createdAt : now, updatedAt: now };
      if (previous) items[index] = item; else items.push(item);
      return { result: item, sounds: previous || !item.sound ? [] : [item.sound] };
    });
  }

  setState(source: string, id: string, state: AttentionState): Promise<void> {
    return this.mutate(async items => {
      validateAttentionIdentity(source, id);
      if (!["pending", "done"].includes(state)) throw new AttentionError("Invalid attention state");
      const item = items.find(item => item.source === source && item.id === id);
      if (!item) throw new AttentionError("Attention item not found", 404);
      if (item.approval) throw new AttentionError("Resolve approval requests using their approval controls.", 409);
      item.state = state; item.updatedAt = this.now();
      return { result: undefined, sounds: [] };
    });
  }

  updateApproval(id: string, approval: CodexApproval): Promise<void> {
    const validated = validateApproval(approval);
    return this.mutate(async items => {
      const item = items.find(item => item.source === CODEX_APPROVAL_SOURCE && item.id === id);
      if (!item?.approval) throw new AttentionError("Approval no longer exists", 404);
      item.approval = validated; item.state = pendingApproval(validated) ? "pending" : "done";
      item.updatedAt = this.now();
      return { result: undefined, sounds: [] };
    });
  }

  setDestination(source: string, id: string, destination: Destination): Promise<void> {
    return this.mutate(async items => {
      validateAttentionIdentity(source, id);
      const validated = validateDestination(destination);
      const item = items.find(item => item.source === source && item.id === id);
      if (!item) throw new AttentionError("Attention item not found", 404);
      item.destination = validated;
      item.updatedAt = this.now();
      return { result: undefined, sounds: [] };
    });
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private mutate<T>(operation: (items: AttentionItem[]) => Promise<{ result: T; sounds: string[] }>): Promise<T> {
    const pending = this.queue.then(async () => {
      if (!this.initialized || this.closed) throw new AttentionError("Attention service is unavailable", 503);
      if (this.error) throw new AttentionError(this.error, 503);
      const items = clone(this.items);
      const { result, sounds } = await operation(items);
      await this.persist(items);
      this.items = items;
      if (!this.closed) {
        for (const listener of this.listeners) { try { listener(this.list()); } catch { /* Observers cannot undo a durable commit. */ } }
        for (const sound of sounds) { try { this.options.onSound?.(sound); } catch { /* Delivery is best effort. */ } }
      }
      return result === undefined ? result : clone(result);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async persist(items: AttentionItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify({ version: 2, items }, null, 2), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, this.filePath);
  }

}
