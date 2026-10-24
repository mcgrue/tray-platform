import { CodexInstance, CodexInstancesSnapshot } from "../shared/codex-instances";

export const CODEX_SCAN_INTERVAL_MS = 5 * 60 * 1000;
export const CODEX_ACTIVITY_INTERVAL_MS = 10 * 1000;

export interface CodexScanResult { instances: CodexInstance[]; warning?: string; }

export class CodexInstanceService {
  private snapshot: CodexInstancesSnapshot;
  private listeners = new Set<(snapshot: CodexInstancesSnapshot) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<CodexInstancesSnapshot>;
  private activityTimer?: ReturnType<typeof setInterval>;
  private activityPending?: Promise<void>;
  private closed = false;

  constructor(private readonly options: {
    scan: () => Promise<CodexScanResult>;
    supported?: boolean;
    now?: () => number;
    activity?: { enrich(instances: CodexInstance[]): Promise<void>; close(): void };
  }) {
    this.snapshot = { instances: [], scanning: false, supported: options.supported ?? process.platform === "win32" };
  }

  start(): void {
    if (this.closed || this.timer || !this.snapshot.supported) return;
    this.timer = setInterval(() => { void this.refresh(); }, CODEX_SCAN_INTERVAL_MS);
    this.timer.unref?.();
    if (this.options.activity) {
      this.activityTimer = setInterval(() => { void this.refreshActivity(); }, CODEX_ACTIVITY_INTERVAL_MS);
      this.activityTimer.unref?.();
    }
    void this.refresh();
  }

  list(): CodexInstancesSnapshot {
    return { ...this.snapshot, instances: this.snapshot.instances.map(item => ({ ...item })) };
  }

  onChanged(listener: (snapshot: CodexInstancesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  refresh(): Promise<CodexInstancesSnapshot> {
    if (this.closed || !this.snapshot.supported) return Promise.resolve(this.list());
    if (this.pending) return this.pending;
    // Defer the runner so concurrent callers and listeners share the same scan.
    this.pending = Promise.resolve().then(() => this.options.scan()).then(result => {
      if (!this.closed) this.snapshot = {
        supported: true, scanning: false, instances: result.instances,
        scannedAt: (this.options.now || Date.now)(), warning: result.warning,
      };
    }).catch(error => {
      if (!this.closed) this.snapshot = { ...this.snapshot, scanning: false,
        error: error instanceof Error ? error.message : String(error) };
    }).then(() => {
      this.pending = undefined;
      if (!this.closed) this.publish();
      if (!this.closed) void this.refreshActivity();
      return this.list();
    });
    this.snapshot = { ...this.snapshot, scanning: true };
    this.publish();
    return this.pending;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.options.activity?.close();
    this.listeners.clear();
  }

  refreshActivity(): Promise<void> {
    if (this.closed || !this.snapshot.supported || !this.options.activity || this.snapshot.scanning) return Promise.resolve();
    if (this.activityPending) return this.activityPending;
    const instances = this.list().instances;
    this.activityPending = Promise.resolve().then(() => this.options.activity!.enrich(instances)).catch(() => {
      instances.forEach(instance => { instance.activity = "unknown"; instance.activityCheckedAt = (this.options.now || Date.now)(); });
    }).then(() => {
      if (this.closed) return;
      // A concurrent inventory scan can replace a process or recycle its PID.
      for (const instance of this.snapshot.instances) {
        const result = instances.find(item => item.codexPid === instance.codexPid && item.codexStartedAt === instance.codexStartedAt);
        if (result) { instance.activity = result.activity; instance.activityCheckedAt = result.activityCheckedAt; }
      }
      this.publish();
    }).finally(() => { this.activityPending = undefined; });
    return this.activityPending;
  }

  private publish(): void { this.listeners.forEach(listener => listener(this.list())); }
}
