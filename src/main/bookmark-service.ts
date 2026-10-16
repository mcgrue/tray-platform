import { promises as fs } from "fs";
import path = require("path");
import { randomBytes } from "crypto";
import { Bookmark, BookmarkInput, BookmarkSnapshot } from "../shared/bookmarks";
import { AttentionError, validateAttentionIdentity, validateDestination } from "./attention-service";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttentionError("Expected a JSON object");
  return value as Record<string, any>;
}

function text(value: unknown, name: string, maximum: number, allowBlank = false): string {
  if (typeof value !== "string" || (!allowBlank && !value.trim()) || value.length > maximum) {
    throw new AttentionError(`Invalid ${name}`);
  }
  return value;
}

function validateMetadata(value: unknown): Partial<BookmarkInput> {
  const input = object(value);
  const result: Partial<BookmarkInput> = {};
  if (input.title !== undefined) result.title = text(input.title, "title", 500);
  if (input.project !== undefined) result.project = text(input.project, "project", 500);
  if (input.destination !== undefined) result.destination = validateDestination(input.destination);
  if (input.attention !== undefined) {
    const attention = object(input.attention);
    validateAttentionIdentity(attention.source, attention.id);
    result.attention = { source: attention.source, id: attention.id };
  }
  return result;
}

function validateStore(value: unknown): Bookmark[] {
  const store = object(value);
  if (store.version !== 1) throw new Error("Unsupported bookmark store version");
  if (!Array.isArray(store.bookmarks)) throw new Error("Invalid bookmark store entries");
  const identities = new Set<string>();
  return store.bookmarks.map((value: unknown) => {
    const item = object(value);
    validateAttentionIdentity(item.source, item.id);
    const identity = JSON.stringify([item.source, item.id]);
    if (identities.has(identity)) throw new Error("Duplicate bookmark identity");
    identities.add(identity);
    const metadata = validateMetadata(item);
    if (!metadata.title || (!metadata.project && !metadata.attention)) throw new Error("Invalid bookmark association or title");
    if (![item.createdAt, item.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0)) throw new Error("Invalid bookmark timestamps");
    const result: Bookmark = {
      ...metadata, title: metadata.title, source: item.source, id: item.id,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
    if (item.humanNote !== undefined) result.humanNote = text(item.humanNote, "human note", 20000, true);
    if (item.robotHint !== undefined) result.robotHint = text(item.robotHint, "robot hint", 20000, true);
    return result;
  });
}

export class BookmarkService {
  private bookmarks: Bookmark[] = [];
  private error?: string;
  private initialized = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: BookmarkSnapshot) => void>();
  private readonly now: () => number;

  constructor(private readonly filePath: string, private readonly options: {
    now?: () => number;
    attentionExists?: (source: string, id: string) => boolean;
  } = {}) { this.now = options.now || Date.now; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      let raw: string;
      try { raw = await fs.readFile(this.filePath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.initialized = true; return; }
        throw error;
      }
      this.bookmarks = validateStore(JSON.parse(raw));
    } catch (error) {
      this.error = `Bookmark store is read-only; existing file preserved: ${(error as Error).message}`;
    }
    this.initialized = true;
  }

  list(): BookmarkSnapshot {
    return { bookmarks: clone(this.bookmarks).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt), ...(this.error ? { error: this.error } : {}) };
  }

  get(source: string, id: string): Bookmark | undefined {
    const bookmark = this.bookmarks.find(item => item.source === source && item.id === id);
    return bookmark ? clone(bookmark) : undefined;
  }

  onChanged(callback: (snapshot: BookmarkSnapshot) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  async saveHuman(source: string, id: string, input: BookmarkInput): Promise<void> {
    await this.save(source, id, input, "human");
  }

  upsertRobot(source: string, id: string, input: BookmarkInput): Promise<Bookmark> {
    return this.save(source, id, input, "robot");
  }

  close(): void { this.closed = true; this.listeners.clear(); }

  private save(source: string, id: string, value: unknown, author: "human" | "robot"): Promise<Bookmark> {
    const pending = this.queue.then(async () => {
      if (!this.initialized || this.closed) throw new AttentionError("Bookmark service is unavailable", 503);
      if (this.error) throw new AttentionError(this.error, 503);
      validateAttentionIdentity(source, id);
      const input = object(value);
      if (author === "robot" && owns(input, "humanNote")) throw new AttentionError("Robots cannot edit human notes");
      const metadata = validateMetadata(input);
      const index = this.bookmarks.findIndex(item => item.source === source && item.id === id);
      const previous = this.bookmarks[index];
      const now = this.now();
      const title = metadata.title || previous?.title;
      if (!title) throw new AttentionError("Title is required when creating a bookmark");
      const bookmark: Bookmark = { ...previous, ...metadata, source, id, title,
        createdAt: previous ? previous.createdAt : now, updatedAt: previous ? previous.updatedAt : now };
      if (!bookmark.project && !bookmark.attention) throw new AttentionError("Choose a project or attention item");
      if (bookmark.attention && this.options.attentionExists && !this.options.attentionExists(bookmark.attention.source, bookmark.attention.id)) {
        throw new AttentionError("Attention item not found", 404);
      }
      // Each author controls one field. Ignore a UI's stale copy of the robot hint.
      if (author === "human" && input.humanNote !== undefined) bookmark.humanNote = text(input.humanNote, "human note", 20000, true);
      if (author === "robot" && input.robotHint !== undefined) bookmark.robotHint = text(input.robotHint, "robot hint", 20000, true);
      if (previous && JSON.stringify(previous) === JSON.stringify(bookmark)) return clone(previous);
      bookmark.updatedAt = now;
      const bookmarks = clone(this.bookmarks);
      if (index >= 0) bookmarks[index] = bookmark; else bookmarks.push(bookmark);
      await this.persist(bookmarks);
      this.bookmarks = bookmarks;
      if (!this.closed) for (const listener of this.listeners) {
        try { listener(this.list()); } catch { /* Observers cannot undo a durable commit. */ }
      }
      return clone(bookmark);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async persist(bookmarks: Bookmark[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify({ version: 1, bookmarks }, null, 2), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, this.filePath);
  }
}
