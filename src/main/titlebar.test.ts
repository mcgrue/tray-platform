import { EventEmitter } from "events";
import type { BrowserWindow } from "electron";
import { parse } from "dotenv";
import { TitlebarController, titlebarConfig, titlebarTextColor, titlebarWindowOptions, windowTitle } from "./titlebar";

function fixture(smokeTest = false, platform = "win32") {
  const window = Object.assign(new EventEmitter(), {
    isFocused: jest.fn(() => false), isDestroyed: jest.fn(() => false), isMaximized: jest.fn(() => false),
    setTitle: jest.fn(), setTitleBarOverlay: jest.fn(), minimize: jest.fn(), maximize: jest.fn(), unmaximize: jest.fn(), close: jest.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: jest.fn(() => false), send: jest.fn() }),
  });
  const config = titlebarConfig({ TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "#ffffff", TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "#123456",
    TRAY_PLATFORM_SMOKETEST: smokeTest ? "1" : "" });
  const controller = new TitlebarController(window as unknown as BrowserWindow, config, platform);
  return { window, config, controller };
}

test("quoted dotenv colors configure each state independently, with defaults for unset values", () => {
  const env = parse('TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR="#ABCDEF"\nTRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR="#123456"');
  expect(titlebarConfig(env)).toEqual({ active: "#abcdef", inactive: "#123456", smokeTest: false });
  expect(titlebarConfig({ TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "#abcdef" }).inactive).toBe("#232c3b");
  expect(titlebarConfig({}).active).toBe("#344768");
  expect(() => titlebarConfig({ TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "olive" })).toThrow("TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR");
});

test("smoke settings override both colors even if user settings are invalid", () => {
  expect(titlebarConfig({ TRAY_PLATFORM_SMOKETEST: "1", TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "invalid",
    TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "#ffffff" })).toEqual({ active: "#4b5320", inactive: "#4b5320", smokeTest: true });
});

test("text contrast handles light and dark backgrounds", () => {
  expect(titlebarTextColor("#ffffff")).toBe("#000000");
  expect(titlebarTextColor("#000000")).toBe("#ffffff");
  expect(titlebarTextColor("#4b5320")).toBe("#ffffff");
});

test("smoke titles have exactly one prefix and preserve application text", () => {
  expect(windowTitle("Attention Inbox", true)).toBe("smoketest - Attention Inbox");
  expect(windowTitle("smoketest - smoketest - Attention Inbox", true)).toBe("smoketest - Attention Inbox");
  expect(windowTitle(" ", true)).toBe("smoketest - Tray Platform");
  expect(windowTitle("Attention Inbox", false)).toBe("Attention Inbox");
});

test("window options retain native controls where Electron 19 supports overlays", () => {
  const config = titlebarConfig({ TRAY_PLATFORM_SMOKETEST: "1" });
  expect(titlebarWindowOptions(config, "win32")).toMatchObject({ title: "smoketest - Tray Platform", titleBarStyle: "hidden",
    titleBarOverlay: { color: "#4b5320", symbolColor: "#ffffff", height: 36 } });
  expect(titlebarWindowOptions(config, "darwin")).toMatchObject({ titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 10 } });
  expect(titlebarWindowOptions(config, "linux")).toMatchObject({ frame: false });
});

test("focus and blur update both native controls and renderer colors without activating the window", () => {
  const { window, controller } = fixture();
  expect(controller.state()).toMatchObject({ color: "#123456", focused: false });
  window.emit("focus");
  expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#ffffff", symbolColor: "#000000" });
  expect(window.webContents.send).toHaveBeenLastCalledWith("titlebar-changed", expect.objectContaining({ color: "#ffffff", focused: true }));
  window.emit("blur");
  expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#123456", symbolColor: "#ffffff" });
  expect(controller.state().focused).toBe(false);
});

test("document title changes and reloads retain the smoke prefix and olive colors", () => {
  const { window, controller } = fixture(true);
  const event = { preventDefault: jest.fn() };
  window.emit("page-title-updated", event, "New title");
  expect(event.preventDefault).toHaveBeenCalled();
  expect(window.setTitle).toHaveBeenLastCalledWith("smoketest - New title");
  window.emit("focus");
  window.webContents.emit("did-finish-load");
  expect(controller.state()).toMatchObject({ title: "smoketest - New title", color: "#4b5320" });
  window.emit("blur");
  expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#4b5320", symbolColor: "#ffffff" });
});

test("other platforms publish colors without calling Windows-only overlay APIs", () => {
  for (const platform of ["darwin", "linux"]) {
    const { window, controller } = fixture(false, platform);
    window.emit("focus");
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(controller.state()).toMatchObject({ color: "#ffffff", platform });
  }
});

test("fallback buttons minimize, toggle maximize, and use the existing close lifecycle", () => {
  const { window, controller } = fixture(false, "linux");
  controller.action("minimize"); controller.action("maximize");
  expect(window.minimize).toHaveBeenCalledTimes(1); expect(window.maximize).toHaveBeenCalledTimes(1);
  window.isMaximized.mockReturnValue(true);
  window.emit("maximize");
  expect(window.webContents.send).toHaveBeenLastCalledWith("titlebar-changed", expect.objectContaining({ maximized: true }));
  controller.action("maximize"); controller.action("close");
  expect(window.unmaximize).toHaveBeenCalledTimes(1); expect(window.close).toHaveBeenCalledTimes(1);
  window.isDestroyed.mockReturnValue(true);
  controller.action("close"); window.emit("blur");
  expect(window.close).toHaveBeenCalledTimes(1);
});
