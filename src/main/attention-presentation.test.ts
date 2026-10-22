import { AttentionPresentation, ATTENTION_SIGNAL_INTERVAL_MS } from "./attention-presentation";
import { AttentionItem, AttentionSnapshot } from "../shared/attention";

const item = (id: string, state: AttentionItem["state"] = "pending"): AttentionItem =>
  ({ source: "test", id, title: id, state, createdAt: 1, updatedAt: 1 });
const snapshot = (...items: AttentionItem[]): AttentionSnapshot => ({ items });
const controllers: AttentionPresentation[] = [];

function fixture(initial = snapshot(), platform = "win32", withDock = true) {
  const window = {
    isVisible: jest.fn(() => false), isMinimized: jest.fn(() => false),
    isFocused: jest.fn(() => false), isDestroyed: jest.fn(() => false),
    hide: jest.fn(), showInactive: jest.fn(), flashFrame: jest.fn(),
  };
  const showPending = jest.fn(), setTrayAlert = jest.fn(), setTitlebarAlert = jest.fn();
  const dock = { bounce: jest.fn(() => 0), cancelBounce: jest.fn() };
  const controller = new AttentionPresentation({ window, platform, showPending, setTrayAlert, setTitlebarAlert, dock: withDock ? dock : undefined }, initial);
  controllers.push(controller);
  return { controller, window, showPending, setTrayAlert, setTitlebarAlert, dock };
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ["performance"] }));
afterEach(() => { controllers.splice(0).forEach(controller => controller.close()); jest.useRealTimers(); });

test("restored pending items start one signal; duplicates and metadata edits never reopen the inbox", () => {
  const f = fixture(snapshot(item("existing")));
  f.controller.update(snapshot({ ...item("existing"), title: "Edited", updatedAt: 2 }, item("done", "done")));
  expect(f.window.showInactive).not.toHaveBeenCalled();
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true]]);
  expect(f.setTitlebarAlert.mock.calls).toEqual([[0]]);
  expect(jest.getTimerCount()).toBe(1);
});

test.each([false, true])("hidden or minimized windows open only through showInactive (minimized=%s)", minimized => {
  const f = fixture();
  f.window.isVisible.mockReturnValue(minimized);
  f.window.isMinimized.mockReturnValue(minimized);
  f.controller.update(snapshot(item("new")));
  expect(f.showPending).toHaveBeenCalledTimes(1);
  expect(f.window.showInactive).toHaveBeenCalledTimes(1);
  expect(f.window.hide).toHaveBeenCalledTimes(minimized ? 1 : 0);
  if (minimized) expect(f.window.hide.mock.invocationCallOrder[0]).toBeLessThan(f.window.showInactive.mock.invocationCallOrder[0]);
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  f.controller.update(snapshot(item("new")));
  expect(f.window.showInactive).toHaveBeenCalledTimes(1);
});

test.each(["darwin", "linux"])("%s uses its native inactive restore without the Windows workaround", platform => {
  const f = fixture(snapshot(), platform);
  f.window.isVisible.mockReturnValue(true);
  f.window.isMinimized.mockReturnValue(true);
  f.controller.update(snapshot(item("new")));
  expect(f.window.hide).not.toHaveBeenCalled();
  expect(f.window.showInactive).toHaveBeenCalledTimes(1);
});

test("tray and titlebar keep cycling until all pending work is resolved, including older items", () => {
  const f = fixture(snapshot(item("old")));
  f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("old"), item("new")));
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true]]);
  jest.advanceTimersByTime(2 * ATTENTION_SIGNAL_INTERVAL_MS);
  expect(f.setTrayAlert.mock.calls).toEqual([[true], [false], [true]]);
  expect(f.setTitlebarAlert.mock.calls).toEqual([[0], [1], [2]]);
  expect(f.window.showInactive).not.toHaveBeenCalled();
  expect(f.showPending).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("old"), item("new", "done")));
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  expect(jest.getTimerCount()).toBe(1);
  f.controller.update(snapshot(item("old", "done"), item("new", "done")));
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  expect(f.setTrayAlert).toHaveBeenLastCalledWith(false);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(undefined);
  expect(jest.getTimerCount()).toBe(0);
});

test("multiple arrivals share one signal and snoozing the final pending item stops it", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.update(snapshot(item("a"), item("b")));
  expect(f.window.flashFrame).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(1);
  f.controller.update(snapshot(item("a", "done"), item("b")));
  expect(jest.getTimerCount()).toBe(1);
  f.controller.update(snapshot(item("a", "done"), item("b", "snoozed")));
  expect(jest.getTimerCount()).toBe(0);
});

test("focus pauses only native flashing; tray and titlebar keep cycling through focus and hiding", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.window.isFocused.mockReturnValue(true);
  f.controller.refreshFocus();
  f.controller.update(snapshot(item("a")));
  jest.advanceTimersByTime(2 * ATTENTION_SIGNAL_INTERVAL_MS);
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true], [false], [true]]);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(2);
  expect(jest.getTimerCount()).toBe(1);
  f.window.isFocused.mockReturnValue(false);
  f.window.isVisible.mockReturnValue(false);
  f.controller.refreshFocus();
  expect(f.window.flashFrame).toHaveBeenLastCalledWith(true);
  jest.advanceTimersByTime(ATTENTION_SIGNAL_INTERVAL_MS);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(3);
});

test("already focused inbox cycles without native flashing, and an expired snooze resumes the signal", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true); f.window.isFocused.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  expect(f.setTrayAlert).toHaveBeenCalledWith(true);
  expect(f.setTitlebarAlert).toHaveBeenCalledWith(0);
  expect(f.window.flashFrame).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("a", "snoozed")));
  f.window.isFocused.mockReturnValue(false);
  f.controller.update(snapshot(item("a")));
  expect(f.window.flashFrame).toHaveBeenCalledWith(true);
});

test("macOS bounces while unfocused and continues tray/titlebar cycles when focus cancels the bounce", () => {
  const f = fixture(snapshot(), "darwin"); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.update(snapshot(item("a"), item("b")));
  expect(f.dock.bounce.mock.calls).toEqual([["critical"]]);
  expect(f.window.flashFrame).not.toHaveBeenCalled();
  expect(f.setTrayAlert.mock.calls).toEqual([[true]]);
  expect(jest.getTimerCount()).toBe(1);
  f.window.isFocused.mockReturnValue(true);
  f.controller.refreshFocus();
  expect(f.dock.cancelBounce.mock.calls).toEqual([[0]]);
  jest.advanceTimersByTime(ATTENTION_SIGNAL_INTERVAL_MS);
  expect(f.setTrayAlert).toHaveBeenLastCalledWith(false);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(1);
  expect(f.dock.bounce).toHaveBeenCalledTimes(1);
  f.window.isFocused.mockReturnValue(false);
  f.controller.refreshFocus();
  expect(f.dock.bounce).toHaveBeenCalledTimes(2);
  f.controller.update(snapshot());
  expect(f.dock.cancelBounce.mock.calls).toEqual([[0], [0]]);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(undefined);
  expect(jest.getTimerCount()).toBe(0);
});

test("a refused Dock bounce is not canceled as a real request", () => {
  const f = fixture(snapshot(), "darwin"); f.window.isVisible.mockReturnValue(true);
  f.dock.bounce.mockReturnValue(-1);
  f.controller.update(snapshot(item("a")));
  f.controller.close();
  expect(f.dock.cancelBounce).not.toHaveBeenCalled();
});

test("missing Dock support falls back to a cancellable tray and taskbar signal", () => {
  const f = fixture(snapshot(), "darwin", false); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.close();
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true], [false]]);
  expect(f.setTitlebarAlert.mock.calls).toEqual([[0], [undefined]]);
  expect(jest.getTimerCount()).toBe(0);
});

test("shutdown restores the normal tray icon and cancels further activity", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.close();
  f.controller.update(snapshot(item("b")));
  jest.advanceTimersByTime(2000);
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true], [false]]);
});

test("destroyed windows stop their timer without calling native window methods", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.window.isDestroyed.mockReturnValue(true);
  jest.advanceTimersByTime(ATTENTION_SIGNAL_INTERVAL_MS);
  expect(jest.getTimerCount()).toBe(0);
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  f.controller.update(snapshot(item("b")));
  expect(f.window.showInactive).not.toHaveBeenCalled();
});

test.each(["win32", "linux", "darwin"])("%s stays idle without pending work and cleans up on shutdown", platform => {
  const f = fixture(snapshot(item("done", "done"), item("later", "snoozed")), platform);
  expect(jest.getTimerCount()).toBe(0);
  expect(f.setTitlebarAlert).not.toHaveBeenCalled();
  expect(f.setTrayAlert).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("a")));
  expect(jest.getTimerCount()).toBe(1);
  f.controller.close();
  expect(jest.getTimerCount()).toBe(0);
  expect(f.setTitlebarAlert).toHaveBeenLastCalledWith(undefined);
  expect(f.setTrayAlert).toHaveBeenLastCalledWith(false);
});
