import { createHash } from "crypto";
import { AttentionError } from "./attention-service";
import { readWebStore, writeWebStore } from "./web-store";

export interface WebReceipt { state: "unknown" | "succeeded"; result?: unknown; error?: string; }
interface RecordEntry extends WebReceipt { owner: string; fingerprint: string; created: number; }
const day = 86400000;

export class WebReceipts {
  private records: Record<string, RecordEntry> = Object.create(null);
  private queue: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Promise<WebReceipt>>();
  constructor(private file: string, private now = Date.now) {}
  async initialize() {
    const data = await readWebStore(this.file, { version: 1, records: {} as Record<string, RecordEntry> });
    if (data.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records)) throw new Error("Invalid web receipt store");
    for (const [id, record] of Object.entries(data.records)) {
      if (!/^\d{13}-[a-f0-9-]{36}$/.test(id) || !record || !["unknown", "succeeded"].includes(record.state) ||
        typeof record.owner !== "string" || typeof record.fingerprint !== "string" || !Number.isFinite(record.created)) throw new Error("Invalid web receipt");
    }
    this.records = Object.assign(Object.create(null), data.records);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => undefined); return next;
  }
  get(owner: string, id: string): WebReceipt | undefined {
    const record = this.records[id];
    if (!record || record.owner !== owner) return undefined;
    return { state: record.state, result: record.result, error: record.error };
  }
  async run(owner: string, id: string, input: unknown, work: () => Promise<unknown>): Promise<WebReceipt> {
    if (typeof id !== "string" || !/^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
      throw new AttentionError("Invalid request ID");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let admitted = false;
    await this.serial(async () => {
      const existing = this.records[id];
      if (existing) {
        if (existing.owner !== owner || existing.fingerprint !== fingerprint) throw new AttentionError("Request ID already used", 409);
        return;
      }
      const timestamp = Number(id.slice(0, 13));
      if (timestamp > this.now() + 60000 || timestamp < this.now() - day) throw new AttentionError("Request expired; check delivery before trying again", 409);
      const records = Object.assign(Object.create(null), this.records);
      for (const key of Object.keys(records)) if (records[key].created < this.now() - 7 * day) delete records[key];
      if (Object.keys(records).length >= 10000) throw new AttentionError("Too many recent requests", 429);
      records[id] = { owner, fingerprint, created: this.now(), state: "unknown" };
      await writeWebStore(this.file, { version: 1, records });
      this.records = records; admitted = true;
    });
    if (!admitted) return this.active.get(id) || this.get(owner, id)!;
    const pending = (async () => {
      let receipt: WebReceipt;
      try { receipt = { state: "succeeded", result: await work() }; }
      catch (error) { receipt = { state: "unknown", error: error instanceof Error ? error.message : "Delivery was not confirmed" }; }
      await this.serial(async () => {
        const records = { ...this.records, [id]: { ...this.records[id], ...receipt } };
        await writeWebStore(this.file, { version: 1, records }); this.records = records;
      });
      return receipt;
    })();
    this.active.set(id, pending);
    try { return await pending; } finally { this.active.delete(id); }
  }
}
