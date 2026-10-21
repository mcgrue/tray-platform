import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { TitlebarAction, TitlebarState } from "../shared/titlebar";

export const TITLEBAR_HEIGHT = 36;
export const SMOKETEST_TITLEBAR_COLOR = "#4b5320";
const SMOKETEST_PREFIX = "smoketest - ";

export interface TitlebarConfig {
  active: string;
  inactive: string;
  activeTextColor?: string;
  inactiveTextColor?: string;
  smokeTest: boolean;
}

function color(value: string | undefined, name: string): string | undefined {
  if (!value?.trim()) return undefined;
  if (!/^#[a-f0-9]{6}$/i.test(value.trim())) throw new Error(`${name} must be a quoted #RRGGBB color`);
  return value.trim().toLowerCase();
}

export function titlebarConfig(env: NodeJS.ProcessEnv): TitlebarConfig {
  if (env.TRAY_PLATFORM_SMOKETEST === "1") {
    return { active: SMOKETEST_TITLEBAR_COLOR, inactive: SMOKETEST_TITLEBAR_COLOR, smokeTest: true };
  }
  return {
    active: color(env.TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR, "TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR") ?? "#344768",
    inactive: color(env.TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR, "TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR") ?? "#232c3b",
    activeTextColor: color(env.TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR, "TRAY_PLATFORM_TITLEBAR_ACTIVE_TEXT_COLOR"),
    inactiveTextColor: color(env.TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR, "TRAY_PLATFORM_TITLEBAR_INACTIVE_TEXT_COLOR"),
    smokeTest: false,
  };
}

export function titlebarTextColor(background: string): string {
  const linear = [1, 3, 5].map(index => {
    const component = parseInt(background.slice(index, index + 2), 16) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

export function windowTitle(title: string, smokeTest: boolean): string {
  let base = title.trim() || "Tray Platform";
  if (smokeTest) {
    while (base.startsWith(SMOKETEST_PREFIX)) base = base.slice(SMOKETEST_PREFIX.length);
    return SMOKETEST_PREFIX + (base || "Tray Platform");
  }
  return base;
}

export function titlebarWindowOptions(config: TitlebarConfig, platform: string): BrowserWindowConstructorOptions {
  const title = windowTitle("Tray Platform", config.smokeTest);
  if (platform === "win32") return {
    title, titleBarStyle: "hidden",
    titleBarOverlay: { color: config.inactive, symbolColor: config.inactiveTextColor ?? titlebarTextColor(config.inactive), height: TITLEBAR_HEIGHT },
  };
  if (platform === "darwin") return {
    title, titleBarStyle: "hidden", titleBarOverlay: { height: TITLEBAR_HEIGHT }, trafficLightPosition: { x: 12, y: 10 },
  };
  // Electron 19 has native overlays only on Windows/macOS. Other platforms use
  // the renderer's three window buttons with the same draggable title region.
  return { title, frame: false };
}

export class TitlebarController {
  private title: string;
  private focused: boolean;

  constructor(private readonly window: BrowserWindow, private readonly config: TitlebarConfig, private readonly platform: string) {
    this.title = windowTitle("Tray Platform", config.smokeTest);
    this.focused = window.isFocused();
    window.setTitle(this.title);
    window.on("focus", () => { this.focused = true; this.publish(); });
    window.on("blur", () => { this.focused = false; this.publish(); });
    window.on("maximize", () => this.publish());
    window.on("unmaximize", () => this.publish());
    window.on("page-title-updated", (event, title) => { event.preventDefault(); this.setTitle(title); });
    window.webContents.on("did-finish-load", () => this.publish());
  }

  state(): TitlebarState {
    const color = this.focused ? this.config.active : this.config.inactive;
    const textColor = (this.focused ? this.config.activeTextColor : this.config.inactiveTextColor) ?? titlebarTextColor(color);
    return { title: this.title, color, textColor, focused: this.focused,
      maximized: this.window.isMaximized(), platform: this.platform };
  }

  setTitle(title: string): void {
    this.title = windowTitle(title, this.config.smokeTest);
    this.window.setTitle(this.title);
    this.publish();
  }

  action(action: TitlebarAction): void {
    if (this.window.isDestroyed()) return;
    if (action === "minimize") this.window.minimize();
    else if (action === "maximize") this.window.isMaximized() ? this.window.unmaximize() : this.window.maximize();
    else if (action === "close") this.window.close();
  }

  private publish(): void {
    if (this.window.isDestroyed()) return;
    const state = this.state();
    if (this.platform === "win32") this.window.setTitleBarOverlay({ color: state.color, symbolColor: state.textColor });
    if (!this.window.webContents.isDestroyed()) this.window.webContents.send("titlebar-changed", state);
  }
}
