import { EventEmitter } from "events";
import type { BrowserWindow } from "electron";
import { ATTENTION_TITLEBAR_COLORS, TitlebarController, titlebarConfig, titlebarTextColor } from "./titlebar";

function fixture(platform: string, smokeTest = false) {
  const window = Object.assign(new EventEmitter(), {
    isFocused: () => false, isDestroyed: jest.fn(() => false), isMaximized: () => false,
    setTitle: jest.fn(), setTitleBarOverlay: jest.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: jest.fn() }),
  });
  const controller = new TitlebarController(window as unknown as BrowserWindow, titlebarConfig({
    TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "#112233", TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "#223344",
    TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR: "#abcdef", TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR: "#fedcba",
    TRAY_PLATFORM_SMOKETEST: smokeTest ? "1" : "",
  }), platform);
  return { window, controller };
}

test.each(["win32", "darwin", "linux"])("%s cycles alert colors across focus/reload and restores configured colors", platform => {
  const { window, controller } = fixture(platform);
  for (let phase = 0; phase <= ATTENTION_TITLEBAR_COLORS.length; phase++) {
    const color = ATTENTION_TITLEBAR_COLORS[phase % ATTENTION_TITLEBAR_COLORS.length];
    controller.setAttentionPhase(phase);
    window.emit("focus");
    window.emit("blur");
    window.webContents.emit("did-finish-load");
    expect(controller.state()).toMatchObject({ color, textColor: titlebarTextColor(color) });
    expect(window.webContents.send).toHaveBeenLastCalledWith("titlebar-changed", expect.objectContaining({ color }));
    if (platform === "win32") expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color, symbolColor: titlebarTextColor(color) });
    else expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  }
  controller.setAttentionPhase(undefined);
  expect(controller.state()).toMatchObject({ color: "#223344", textColor: "#fedcba" });
  window.emit("focus");
  controller.setAttentionPhase(0);
  controller.setAttentionPhase(undefined);
  expect(controller.state()).toMatchObject({ color: "#112233", textColor: "#abcdef" });
});

test("pending work also cycles in smoke mode, retaining its prefix and restoring olive afterward", () => {
  const { controller } = fixture("win32", true);
  controller.setAttentionPhase(0);
  expect(controller.state()).toMatchObject({ title: "smoketest - Tray Platform", color: ATTENTION_TITLEBAR_COLORS[0] });
  controller.setAttentionPhase(undefined);
  expect(controller.state()).toMatchObject({ color: "#4b5320", textColor: "#ffffff" });
});

test("clearing a destroyed window's alert never calls native or renderer methods", () => {
  const { window, controller } = fixture("win32");
  controller.setAttentionPhase(0);
  window.isDestroyed.mockReturnValue(true);
  window.setTitleBarOverlay.mockClear();
  window.webContents.send.mockClear();
  controller.setAttentionPhase(undefined);
  expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  expect(window.webContents.send).not.toHaveBeenCalled();
});
