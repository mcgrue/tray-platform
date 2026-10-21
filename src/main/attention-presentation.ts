import { AttentionSnapshot } from "../shared/attention";

interface AttentionWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  showInactive(): void;
  flashFrame(flag: boolean): void;
}

interface AttentionPresentationOptions {
  window: AttentionWindow;
  platform: string;
  showPending(): void;
  setTrayAlert(active: boolean): void;
  dock?: { bounce(type: "critical"): number; cancelBounce(id: number): void };
}

const pendingKeys = (snapshot: AttentionSnapshot) => new Set(snapshot.items
  .filter(item => item.state === "pending").map(item => JSON.stringify([item.source, item.id])));

/** Presents newly pending work without ever activating the window. Startup is silent. */
export class AttentionPresentation {
  private pending: Set<string>;
  private signalled = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private bounceId?: number;
  private signalling = false;
  private alertImage = false;
  private closed = false;

  constructor(private readonly options: AttentionPresentationOptions, initial: AttentionSnapshot) {
    this.pending = pendingKeys(initial);
  }

  update(snapshot: AttentionSnapshot): void {
    if (this.closed || this.options.window.isDestroyed()) return;
    const next = pendingKeys(snapshot);
    const arrivals = [...next].filter(key => !this.pending.has(key));
    this.pending = next;
    for (const key of this.signalled) if (!next.has(key)) this.signalled.delete(key);
    if (!this.signalled.size) this.stopSignal();
    if (!arrivals.length) return;

    const window = this.options.window;
    if (window.isFocused()) { this.acknowledge(); return; }
    if (!window.isVisible() || window.isMinimized()) {
      this.options.showPending();
      // restore() and show() can activate the window; use the inactive path even
      // when it was minimized. Explicit user navigation still uses show/focus.
      window.showInactive();
      return;
    }
    arrivals.forEach(key => this.signalled.add(key));
    this.startSignal();
  }

  acknowledge(): void {
    this.signalled.clear();
    this.stopSignal();
  }

  close(): void {
    this.closed = true;
    this.acknowledge();
  }

  private startSignal(): void {
    if (this.signalling) return;
    this.signalling = true;
    if (this.options.platform === "darwin" && this.options.dock) {
      const id = this.options.dock.bounce("critical");
      if (id >= 0) this.bounceId = id;
      return;
    }
    this.options.window.flashFrame(true);
    this.alertImage = true;
    this.options.setTrayAlert(true);
    this.timer = setInterval(() => {
      if (this.options.window.isDestroyed() || this.options.window.isFocused()) {
        this.acknowledge();
        return;
      }
      this.alertImage = !this.alertImage;
      this.options.setTrayAlert(this.alertImage);
    }, 500);
    this.timer.unref?.();
  }

  private stopSignal(): void {
    if (!this.signalling) return;
    this.signalling = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.bounceId !== undefined) {
      this.options.dock?.cancelBounce(this.bounceId);
      this.bounceId = undefined;
    }
    if (this.options.platform !== "darwin" || !this.options.dock) {
      if (!this.options.window.isDestroyed()) this.options.window.flashFrame(false);
      this.options.setTrayAlert(false);
    }
    this.alertImage = false;
  }
}
