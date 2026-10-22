import { AttentionSnapshot } from "../shared/attention";

interface AttentionWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  hide(): void;
  showInactive(): void;
  flashFrame(flag: boolean): void;
}

interface AttentionPresentationOptions {
  window: AttentionWindow;
  platform: string;
  showPending(): void;
  setTrayAlert(active: boolean): void;
  setTitlebarAlert?(phase: number | undefined): void;
  dock?: { bounce(type: "critical"): number; cancelBounce(id: number): void };
}

const pendingKeys = (snapshot: AttentionSnapshot) => new Set(snapshot.items
  .filter(item => item.state === "pending").map(item => JSON.stringify([item.source, item.id])));

export const ATTENTION_SIGNAL_INTERVAL_MS = 1000;

/** Pending work keeps its visual signal until resolved, without activating the window. */
export class AttentionPresentation {
  private pending: Set<string>;
  private timer?: ReturnType<typeof setInterval>;
  private bounceId?: number;
  private signalling = false;
  private nativeSignalling = false;
  private alertImage = false;
  private phase = 0;
  private closed = false;

  constructor(private readonly options: AttentionPresentationOptions, initial: AttentionSnapshot) {
    this.pending = pendingKeys(initial);
    if (this.pending.size && !options.window.isDestroyed()) this.startSignal();
  }

  update(snapshot: AttentionSnapshot): void {
    if (this.closed || this.options.window.isDestroyed()) return;
    const next = pendingKeys(snapshot);
    const arrivals = [...next].filter(key => !this.pending.has(key));
    this.pending = next;
    if (next.size) this.startSignal(); else this.stopSignal();
    if (!arrivals.length) return;

    const window = this.options.window;
    if (window.isFocused()) return;
    if (!window.isVisible() || window.isMinimized()) {
      this.options.showPending();
      // restore() and show() can activate the window; use the inactive path even
      // when it was minimized. Explicit user navigation still uses show/focus.
      // On Windows, Electron 19's showInactive() implicitly activates a minimized
      // window. Hiding it first avoids that native restore path.
      if (this.options.platform === "win32" && window.isMinimized()) window.hide();
      window.showInactive();
    }
  }

  refreshFocus(): void {
    if (this.closed || this.options.window.isDestroyed() || !this.signalling) return;
    if (this.options.window.isFocused()) {
      this.stopNativeSignal();
    } else if (!this.nativeSignalling) {
      this.nativeSignalling = true;
      if (this.options.platform === "darwin" && this.options.dock) {
        const id = this.options.dock.bounce("critical");
        if (id >= 0) this.bounceId = id;
      } else {
        this.options.window.flashFrame(true);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopSignal();
  }

  private startSignal(): void {
    if (this.signalling) return;
    this.signalling = true;
    this.alertImage = true;
    this.phase = 0;
    this.options.setTrayAlert(true);
    this.options.setTitlebarAlert?.(this.phase);
    this.refreshFocus();
    this.timer = setInterval(() => {
      if (this.options.window.isDestroyed()) {
        this.close();
        return;
      }
      this.alertImage = !this.alertImage;
      this.options.setTrayAlert(this.alertImage);
      this.options.setTitlebarAlert?.(++this.phase);
      this.refreshFocus();
    }, ATTENTION_SIGNAL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopSignal(): void {
    if (!this.signalling) return;
    this.signalling = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.stopNativeSignal();
    this.options.setTrayAlert(false);
    this.options.setTitlebarAlert?.(undefined);
    this.alertImage = false;
  }

  private stopNativeSignal(): void {
    if (!this.nativeSignalling) return;
    this.nativeSignalling = false;
    if (this.bounceId !== undefined) {
      this.options.dock?.cancelBounce(this.bounceId);
      this.bounceId = undefined;
    }
    if (this.options.platform !== "darwin" || !this.options.dock) {
      if (!this.options.window.isDestroyed()) this.options.window.flashFrame(false);
    }
  }
}
