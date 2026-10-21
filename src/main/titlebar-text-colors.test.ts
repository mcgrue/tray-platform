import { EventEmitter } from "events";
import type { BrowserWindow } from "electron";
import { parse } from "dotenv";
import { TitlebarController, titlebarConfig, titlebarWindowOptions } from "./titlebar";

function fixture(env: NodeJS.ProcessEnv) {
  const window = Object.assign(new EventEmitter(), {
    isFocused: () => false, isDestroyed: () => false, isMaximized: () => false,
    setTitle: jest.fn(), setTitleBarOverlay: jest.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: jest.fn() }),
  });
  const config = titlebarConfig(env);
  const controller = new TitlebarController(window as unknown as BrowserWindow, config, "win32");
  return { window, config, controller };
}

test("dotenv text colors reach native controls and renderer on load, focus, and blur", () => {
  const { window, config, controller } = fixture(parse([
    'TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR=" #AABBCC "',
    'TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR="#DDEEFF"',
  ].join("\n")));
  expect(titlebarWindowOptions(config, "win32").titleBarOverlay).toMatchObject({ symbolColor: "#ddeeff" });
  expect(controller.state().textColor).toBe("#ddeeff");
  for (const [event, textColor, focused] of [
    ["did-finish-load", "#ddeeff", false], ["focus", "#aabbcc", true], ["blur", "#ddeeff", false],
  ] as const) {
    (event === "did-finish-load" ? window.webContents : window).emit(event);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ symbolColor: textColor }));
    expect(window.webContents.send).toHaveBeenLastCalledWith("titlebar-changed", expect.objectContaining({ textColor, focused }));
  }
});

test.each([undefined, "", "  "])("unset or blank text color (%p) preserves contrast independently", value => {
  const activeOverride = fixture({
    TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR: "#abcdef",
    TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR: value,
    TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "#ffffff",
  });
  expect(activeOverride.controller.state().textColor).toBe("#000000");
  expect(titlebarWindowOptions(activeOverride.config, "win32").titleBarOverlay).toMatchObject({ symbolColor: "#000000" });
  activeOverride.window.emit("focus");
  expect(activeOverride.controller.state().textColor).toBe("#abcdef");

  const inactiveOverride = fixture({
    TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR: value,
    TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR: "#123456",
    TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "#000000",
  });
  expect(inactiveOverride.controller.state().textColor).toBe("#123456");
  inactiveOverride.window.emit("focus");
  expect(inactiveOverride.controller.state().textColor).toBe("#ffffff");
});

test.each(["TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR", "TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR"])(
  "%s rejects invalid colors", name => {
    for (const value of ["red", "#abc", "#12345678", "123456", "#gg0000"]) {
      expect(() => titlebarConfig({ [name]: value })).toThrow(`${name} must be a quoted #RRGGBB color`);
    }
  },
);

test.each(["#000000", "invalid"])("smoke mode ignores text overrides (%s) and keeps white text", value => {
  const { window, config, controller } = fixture({
    TRAY_PLATFORM_SMOKETEST: "1",
    TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR: value,
    TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR: value,
  });
  expect(titlebarWindowOptions(config, "win32").titleBarOverlay).toMatchObject({ color: "#4b5320", symbolColor: "#ffffff" });
  expect(controller.state().textColor).toBe("#ffffff");
  window.emit("focus");
  expect(controller.state().textColor).toBe("#ffffff");
});
