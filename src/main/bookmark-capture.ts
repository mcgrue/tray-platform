import { WindowDestination } from "../shared/attention";
import { BookmarkCapture } from "../shared/bookmarks";

/** Capture the foreground window before any application UI can steal focus. */
export class BookmarkCaptureService {
  private pending?: Promise<void>;

  constructor(private readonly options: {
    captureForeground: () => Promise<WindowDestination | undefined>;
    showCapture: (capture: BookmarkCapture) => void;
  }) {}

  request(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let capture: BookmarkCapture;
      try {
        const destination = await this.options.captureForeground();
        capture = destination ? { destination } : {};
      } catch (error) {
        capture = { error: error instanceof Error ? error.message : String(error) };
      }
      this.options.showCapture(capture);
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
