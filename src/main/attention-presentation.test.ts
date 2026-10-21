import { AttentionPresentation } from "./attention-presentation";
import { AttentionItem, AttentionSnapshot } from "../shared/attention";

const item = (id: string, state: AttentionItem["state"] = "pending"): AttentionItem =>
  ({ source: "test", id, title: id, state, createdAt: 1, updatedAt: 1 });
const snapshot = (...items: AttentionItem[]): AttentionSnapshot => ({ items });
const controllers: AttentionPresentation[] = [];

function fixture(initial = snapshot(), platform = "win32", withDock = true) {
  const window = {
    isVisible: jest.fn(() => false), isMinimized: jest.fn(() => false),
    isFocused: jest.fn(() => false), isDestroyed: jest.fn(() => false),
    showInactive: jest.fn(), flashFrame: jest.fn(),
  };
  const showPending = jest.fn(), setTrayAlert = jest.fn();
  const dock = { bounce: jest.fn(() => 0), cancelBounce: jest.fn() };
  const controller = new AttentionPresentation({ window, platform, showPending, setTrayAlert, dock: withDock ? dock : undefined }, initial);
  controllers.push(controller);
  return { controller, window, showPending, setTrayAlert, dock };
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ["performance"] }));
afterEach(() => { controllers.splice(0).forEach(controller => controller.close()); jest.useRealTimers(); });

test("startup, repeated delivery, metadata edits and completed items do not open the inbox", () => {
  const f = fixture(snapshot(item("existing")));
  f.controller.update(snapshot({ ...item("existing"), title: "Edited", updatedAt: 2 }, item("done", "done")));
  expect(f.window.showInactive).not.toHaveBeenCalled();
  expect(f.window.flashFrame).not.toHaveBeenCalled();
  expect(f.setTrayAlert).not.toHaveBeenCalled();
});

test.each([false, true])("hidden or minimized windows open only through showInactive (minimized=%s)", minimized => {
  const f = fixture();
  f.window.isVisible.mockReturnValue(minimized);
  f.window.isMinimized.mockReturnValue(minimized);
  f.controller.update(snapshot(item("new")));
  expect(f.showPending).toHaveBeenCalledTimes(1);
  expect(f.window.showInactive).toHaveBeenCalledTimes(1);
  expect(f.window.flashFrame).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("new")));
  expect(f.window.showInactive).toHaveBeenCalledTimes(1);
});

test("visible inactive inbox blinks until the triggering item is resolved, even with older pending work", () => {
  const f = fixture(snapshot(item("old")));
  f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("old"), item("new")));
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  expect(f.setTrayAlert.mock.calls).toEqual([[true]]);
  jest.advanceTimersByTime(1000);
  expect(f.setTrayAlert.mock.calls).toEqual([[true], [false], [true]]);
  expect(f.window.showInactive).not.toHaveBeenCalled();
  expect(f.showPending).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("old"), item("new", "done")));
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  expect(f.setTrayAlert).toHaveBeenLastCalledWith(false);
  expect(jest.getTimerCount()).toBe(0);
});

test("multiple arrivals share one signal and snoozing the final triggering item stops it", () => {
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

test("acknowledgment stops blinking without completing items or restarting on later updates", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.acknowledge();
  f.controller.update(snapshot(item("a")));
  jest.advanceTimersByTime(2000);
  expect(f.window.flashFrame.mock.calls).toEqual([[true], [false]]);
  f.controller.update(snapshot(item("a"), item("b")));
  expect(f.window.flashFrame).toHaveBeenLastCalledWith(true);
});

test("already focused inbox does not signal, but an expired snooze alerts after focus leaves", () => {
  const f = fixture(); f.window.isVisible.mockReturnValue(true); f.window.isFocused.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  expect(f.setTrayAlert).not.toHaveBeenCalled();
  f.controller.update(snapshot(item("a", "snoozed")));
  f.window.isFocused.mockReturnValue(false);
  f.controller.update(snapshot(item("a")));
  expect(f.window.flashFrame).toHaveBeenCalledWith(true);
});

test("macOS uses one persistent Dock bounce and cancels request ID zero on acknowledgment", () => {
  const f = fixture(snapshot(), "darwin"); f.window.isVisible.mockReturnValue(true);
  f.controller.update(snapshot(item("a")));
  f.controller.update(snapshot(item("a"), item("b")));
  expect(f.dock.bounce.mock.calls).toEqual([["critical"]]);
  expect(f.window.flashFrame).not.toHaveBeenCalled();
  expect(f.setTrayAlert).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  f.controller.acknowledge();
  expect(f.dock.cancelBounce.mock.calls).toEqual([[0]]);
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
  jest.advanceTimersByTime(500);
  expect(jest.getTimerCount()).toBe(0);
  expect(f.window.flashFrame.mock.calls).toEqual([[true]]);
  f.controller.update(snapshot(item("b")));
  expect(f.window.showInactive).not.toHaveBeenCalled();
});
