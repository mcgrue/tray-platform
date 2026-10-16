import { BookmarkCaptureService } from "./bookmark-capture";
import { WindowDestination } from "../shared/attention";

const destination: WindowDestination = { kind: "window", hwnd: "123", pid: 456, processStartedAt: "2026-10-16T00:00:00Z", title: "Original foreground" };

test("awaits foreground capture before opening UI, even while capture remains pending", async () => {
  const order: string[] = [];
  let resolve!: (value: WindowDestination) => void;
  const service = new BookmarkCaptureService({
    captureForeground: () => { order.push("capture"); return new Promise(value => { resolve = value; }); },
    showCapture: capture => { order.push("show"); expect(capture).toEqual({ destination }); },
  });
  const pending = service.request();
  expect(order).toEqual(["capture"]);
  await Promise.resolve();
  expect(order).toEqual(["capture"]);
  resolve(destination); await pending;
  expect(order).toEqual(["capture", "show"]);
});

test("coalesces simultaneous invocations and allows another capture after the editor was shown", async () => {
  let resolve!: (value: WindowDestination) => void;
  const captureForeground = jest.fn().mockImplementationOnce(() => new Promise(value => { resolve = value; })).mockResolvedValue(undefined);
  const showCapture = jest.fn();
  const service = new BookmarkCaptureService({ captureForeground, showCapture });
  const first = service.request(); const second = service.request(); const third = service.request();
  expect(first).toBe(second); expect(first).toBe(third);
  expect(captureForeground).toHaveBeenCalledTimes(1);
  resolve(destination); await Promise.all([first, second, third]);
  expect(showCapture).toHaveBeenCalledTimes(1);
  await service.request();
  expect(captureForeground).toHaveBeenCalledTimes(2); expect(showCapture).toHaveBeenCalledTimes(2);
});

test("capture failure still opens a usable editor without a destination", async () => {
  const showCapture = jest.fn();
  const service = new BookmarkCaptureService({ captureForeground: async () => { throw new Error("Windows helper unavailable"); }, showCapture });
  await expect(service.request()).resolves.toBeUndefined();
  expect(showCapture).toHaveBeenCalledWith({ error: "Windows helper unavailable" });
});

test("missing external foreground window opens an editor with no destination", async () => {
  const showCapture = jest.fn();
  const service = new BookmarkCaptureService({ captureForeground: async () => undefined, showCapture });
  await service.request(); expect(showCapture).toHaveBeenCalledWith({});
});

test("synchronous capture failure is handled and the next request can recover", async () => {
  const captureForeground = jest.fn().mockImplementationOnce(() => { throw "capture failed"; }).mockResolvedValue(destination);
  const showCapture = jest.fn();
  const service = new BookmarkCaptureService({ captureForeground, showCapture });
  await service.request(); await service.request();
  expect(showCapture.mock.calls).toEqual([[{ error: "capture failed" }], [{ destination }]]);
});
