import { createHash } from "crypto";
import { AttentionItem, AttentionSnapshot } from "../shared/attention";
import { AttentionError } from "./attention-service";
import { readWebStore, writeWebStore } from "./web-store";

const webpush = require("web-push");
export interface WebSubscription { endpoint: string; keys: { p256dh: string; auth: string }; }
interface Device { owner: string; subscription: WebSubscription; }
interface PushStore { version: number; keys: { publicKey: string; privateKey: string }; devices: Record<string, Device>; seen: Record<string, string>; }
type Sender = (subscription: WebSubscription, payload: string, options: any) => Promise<unknown>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function validateSubscription(value: any): WebSubscription {
  let url: URL;
  try { url = new URL(value?.endpoint); } catch { throw new AttentionError("Invalid push subscription"); }
  // Exact production hosts prevent subscription SSRF. Keep provider URLs opaque.
  const provider = url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com";
  if (url.protocol !== "https:" || !provider || url.port || url.username || url.password || url.hash ||
    url.pathname === "/" || url.href.length > 4096) throw new AttentionError("This browser's push provider is not supported. Use Firefox or Chrome on Android.");
  const keys = value.keys;
  if (!keys || !/^[\w-]{87}=?$/.test(keys.p256dh) || !/^[\w-]{22}={0,2}$/.test(keys.auth) ||
    Buffer.from(keys.p256dh, "base64").length !== 65 || Buffer.from(keys.auth, "base64").length !== 16) throw new AttentionError("Invalid push keys");
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export class WebPushService {
  private store!: PushStore;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private latest: AttentionSnapshot = { items: [] };
  private previous = new Map<string, AttentionItem>();
  private deliveries = new Set<Promise<unknown>>();
  constructor(private file: string, private origin: string, private sender: Sender = webpush.sendNotification.bind(webpush),
    private allowedUsers: string[] = []) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => undefined); return next;
  }
  async initialize(snapshot: AttentionSnapshot) {
    this.store = await readWebStore<PushStore>(this.file, { version: 1, keys: webpush.generateVAPIDKeys(), devices: {}, seen: {} });
    if (this.store.version !== 1 || !this.store.keys?.publicKey || !this.store.keys?.privateKey ||
      !this.store.devices || !this.store.seen || Array.isArray(this.store.devices)) throw new Error("Invalid push store");
    for (const device of Object.values(this.store.devices)) {
      if (!device || typeof device.owner !== "string") throw new Error("Invalid push device");
      validateSubscription(device.subscription);
    }
    this.latest = snapshot;
    // Startup is a baseline, not a replay of the backlog.
    this.previous = new Map(snapshot.items.map(item => [this.key(item), item]));
    await writeWebStore(this.file, this.store);
  }
  get publicKey() { return this.store.keys.publicKey; }
  private key(item: AttentionItem) { return digest(JSON.stringify([item.source, item.id])); }
  async subscribe(owner: string, value: unknown) {
    const subscription = validateSubscription(value), id = digest(subscription.endpoint);
    await this.serial(async () => {
      if (Object.keys(this.store.devices).length >= 32 && !this.store.devices[id]) throw new AttentionError("Too many notification devices", 429);
      const next = { ...this.store, devices: { ...this.store.devices, [id]: { owner, subscription } } };
      await writeWebStore(this.file, next); this.store = next;
    });
    return { id };
  }
  async unsubscribe(owner: string, endpoint: string) {
    await this.serial(async () => {
      const id = digest(String(endpoint)), device = this.store.devices[id];
      if (!device || device.owner !== owner) return;
      const devices = { ...this.store.devices }; delete devices[id];
      const next = { ...this.store, devices }; await writeWebStore(this.file, next); this.store = next;
    });
  }
  async test(owner: string, endpoint: string) {
    const device = this.store.devices[digest(String(endpoint))];
    if (!device || device.owner !== owner) throw new AttentionError("Enable notifications on this device first", 404);
    await this.send(device, { title: "Tray Platform", body: "Notifications are working.", tag: "tray-test", url: "/" });
  }
  update(snapshot: AttentionSnapshot) {
    if (this.stopped) return;
    this.latest = snapshot;
    const events: AttentionItem[] = [];
    for (const item of snapshot.items) {
      const old = this.previous.get(this.key(item));
      if (item.state === "pending" && !old) events.push(item);
    }
    this.previous = new Map(snapshot.items.map(item => [this.key(item), item]));
    for (const item of events) {
      const task = this.notify(item).catch(() => console.error("Attention push failed; inbox state is unchanged."));
      this.deliveries.add(task); void task.finally(() => this.deliveries.delete(task));
    }
  }
  private async notify(item: AttentionItem) {
    const key = this.key(item), event = `${item.createdAt}:${item.updatedAt}`;
    let devices: Device[] = [];
    await this.serial(async () => {
      if (this.stopped || this.store.seen[key] === event) return;
      const seen = { ...this.store.seen, [key]: event };
      const live = new Set(this.latest.items.map(value => this.key(value)));
      for (const id of Object.keys(seen)) if (!live.has(id)) delete seen[id];
      const next = { ...this.store, seen }; await writeWebStore(this.file, next); this.store = next;
      devices = Object.values(this.store.devices).filter(device => this.allowedUsers.includes(device.owner));
    });
    const url = `/#item=${encodeURIComponent(JSON.stringify([item.source, item.id]))}`;
    const project = (item.project || "").split(/[\\/]/).filter(Boolean).pop();
    const payload = { title: item.title.slice(0, 160), body: project || "Tray Platform needs attention", tag: key, url };
    await Promise.all(devices.map(async device => {
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
        const current = this.latest.items.find(value => this.key(value) === key);
        if (current?.state !== "pending" || current.updatedAt !== item.updatedAt) return;
        try { await this.send(device, payload); return; }
        catch (error) {
          const status = (error as any).statusCode;
          if (status === 404 || status === 410) { await this.unsubscribe(device.owner, device.subscription.endpoint); return; }
          if (attempt === 2 || (status && status !== 429 && status < 500)) throw error;
          await new Promise(resolve => { const timer = setTimeout(resolve, 1000 * (attempt + 1)); timer.unref?.(); });
        }
      }
    }));
  }
  private send(device: Device, payload: { title: string; body: string; tag: string; url: string }) {
    return this.sender(device.subscription, JSON.stringify(payload), { TTL: 300, timeout: 10000, urgency: "normal",
      topic: payload.tag.slice(0, 32), vapidDetails: { subject: this.origin, ...this.store.keys } });
  }
  async settled() { await this.queue; await Promise.all([...this.deliveries]); }
  close() { this.stopped = true; }
}
