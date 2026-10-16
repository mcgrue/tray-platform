import { promises as fs } from "fs";
import path = require("path");
import { randomBytes } from "crypto";
import { ShortcutKey, ShortcutSetting, ShortcutSnapshot } from "../shared/attention";

interface ShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered?(accelerator: string): boolean;
}
interface ShortcutDefinition {
  key: ShortcutKey;
  defaultAccelerator: string;
  onInvoke: () => void;
}

function accelerator(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Shortcut must be a nonempty accelerator of at most 200 characters");
  return value;
}

function acceleratorIdentity(value: string): string {
  // Windows accepts modifier aliases and any modifier order for the same binding.
  const aliases: Record<string, string> = { control: "ctrl", option: "alt", commandorcontrol: "ctrl", cmdorctrl: "ctrl" };
  return value.toLowerCase().split("+").map(part => aliases[part.trim()] || part.trim()).sort().join("+");
}

export class ShortcutService {
  private stored: Record<string, string> = Object.create(null);
  private settings: ShortcutSetting[] = [];
  private registered = new Map<ShortcutKey, string>();
  private listeners = new Set<(snapshot: ShortcutSnapshot) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private closed = false;
  private error?: string;

  constructor(private readonly filePath: string, private readonly adapter: ShortcutAdapter, private readonly definitions: ShortcutDefinition[]) {
    const keys = new Set<ShortcutKey>();
    for (const definition of definitions) {
      if (keys.has(definition.key)) throw new Error(`Duplicate shortcut definition: ${definition.key}`);
      keys.add(definition.key);
      accelerator(definition.defaultAccelerator);
    }
    this.settings = definitions.map(definition => ({ key: definition.key, accelerator: definition.defaultAccelerator, registered: false }));
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.closed) return;
    try {
      let raw: string;
      try { raw = await fs.readFile(this.filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; raw = '{"version":1,"accelerators":{}}'; }
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) throw new Error("Unsupported shortcut store version");
      if (!parsed.accelerators || typeof parsed.accelerators !== "object" || Array.isArray(parsed.accelerators)) throw new Error("Invalid shortcut settings");
      for (const key of Object.keys(parsed.accelerators)) this.stored[key] = accelerator(parsed.accelerators[key]);
      this.settings = this.definitions.map(definition => ({ key: definition.key, accelerator: this.stored[definition.key] || definition.defaultAccelerator, registered: false }));
    } catch (error) {
      this.stored = Object.create(null);
      this.error = `Shortcut settings are read-only; existing file preserved: ${(error as Error).message}`;
    }
    this.initialized = true;
    this.reconcile();
    this.publish();
  }

  list(): ShortcutSnapshot {
    return { settings: this.settings.map(setting => ({ ...setting })), ...(this.error ? { error: this.error } : {}) };
  }

  set(key: ShortcutKey, requested: string): Promise<void> {
    const pending = this.queue.then(async () => {
      if (!this.initialized || this.closed) throw new Error("Shortcut service is unavailable");
      if (this.error) throw new Error(this.error);
      const setting = this.settings.find(setting => setting.key === key);
      if (!setting) throw new Error("Unknown shortcut key");
      const value = accelerator(requested);
      const stored = { ...this.stored, [key]: value };
      await this.persist(stored);
      this.stored = stored;
      setting.accelerator = value;
      this.reconcile();
      this.publish();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  onChanged(callback: (snapshot: ShortcutSnapshot) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const owned of this.registered.values()) {
      try { this.adapter.unregister(owned); } catch { /* Exit should continue if the OS rejects cleanup. */ }
    }
    this.registered.clear();
    for (const setting of this.settings) setting.registered = false;
    this.listeners.clear();
  }

  private reconcile(): void {
    if (this.closed) return;
    // Only release accelerators this service successfully registered for this key.
    for (const setting of this.settings) {
      const owned = this.registered.get(setting.key);
      if (owned !== undefined && owned !== setting.accelerator) {
        try { this.adapter.unregister(owned); this.registered.delete(setting.key); }
        catch (error) { setting.error = `Could not release previous shortcut: ${(error as Error).message}`; }
      }
    }
    for (const definition of this.definitions) {
      const setting = this.settings.find(entry => entry.key === definition.key)!;
      const owned = this.registered.get(setting.key);
      setting.registered = owned === setting.accelerator;
      if (setting.registered) { delete setting.error; continue; }
      if (owned !== undefined) continue;
      if ([...this.registered.values()].some(value => acceleratorIdentity(value) === acceleratorIdentity(setting.accelerator))) {
        setting.error = "Shortcut is already assigned to another action";
        continue;
      }
      try {
        if (this.adapter.isRegistered?.(setting.accelerator)) {
          setting.error = "Shortcut is already registered by another action";
          continue;
        }
        const registered = this.adapter.register(setting.accelerator, () => {
          if (!this.closed) definition.onInvoke();
        });
        if (!registered) setting.error = "Shortcut is unavailable or conflicts with another application";
        else {
          this.registered.set(setting.key, setting.accelerator);
          setting.registered = true;
          delete setting.error;
        }
      } catch (error) { setting.error = `Shortcut could not be registered: ${(error as Error).message}`; }
    }
  }

  private publish(): void {
    if (this.closed) return;
    for (const listener of this.listeners) { try { listener(this.list()); } catch { /* Notification cannot roll back a saved setting. */ } }
  }

  private async persist(accelerators: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify({ version: 1, accelerators }, null, 2), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.filePath);
  }
}
