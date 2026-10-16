import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import { AttentionService } from "./attention-service";
import { createAttentionApi } from "./attention-api";
import { DesktopService } from "./desktop-service";
import { setWindow } from "./renderer-window";
import { setupTray } from "./tray";
import { createServer } from "./webserver";
import { AttentionState, Destination } from "../shared/attention";

require("dotenv").config();

// These overrides also allow isolated desktop smoke checks without touching live data.
if (process.env.TRAY_PLATFORM_USER_DATA) app.setPath("userData", process.env.TRAY_PLATFORM_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

export const applicationReady = singleInstance ? app.whenReady().then(async () => {
  let rendererReady = false;
  let quitting = false;
  const audioQueue: Array<{ channel: string; value: string }> = [];
  const mainWindow = new BrowserWindow({
    width: 920,
    height: 760,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload_js.js"),
    },
  });
  setWindow(mainWindow);
  const sendAudio = (channel: string, value: string) => {
    if (!rendererReady || mainWindow.isDestroyed()) audioQueue.push({ channel, value });
    else mainWindow.webContents.send(channel, value);
  };
  const attention = new AttentionService(path.join(app.getPath("userData"), "attention.json"), {
    onSound: (id) => sendAudio("play-sound", id),
  });
  await attention.initialize();
  const desktop = new DesktopService({ openUrl: (link) => shell.openExternal(link), appPid: process.pid });
  const showInbox = () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  const tray = setupTray({ showInbox, quit: () => app.quit() });
  const publish = () => {
    const snapshot = attention.list();
    const pending = snapshot.items.filter((item) => item.state === "pending").length;
    if (tray) tray.setToolTip(`Tray Platform — ${pending} pending${snapshot.error ? " — storage error" : ""}`);
    if (rendererReady && !mainWindow.isDestroyed()) mainWindow.webContents.send("attention-changed", snapshot);
  };
  const unsubscribe = attention.onChanged(publish);
  const findItem = (source: string, id: string) => {
    const item = attention.list().items.find((entry) => entry.source === source && entry.id === id);
    if (!item) throw new Error("Attention item no longer exists");
    return item;
  };
  ipcMain.handle("attention-list", () => attention.list());
  ipcMain.handle("attention-state", (_event, source: string, id: string, state: AttentionState, minutes?: number) =>
    attention.setState(source, id, state, minutes));
  ipcMain.handle("attention-go", async (_event, source: string, id: string) => {
    const item = findItem(source, id);
    if (!item.destination) throw new Error("Choose a destination first");
    await desktop.activate(item.destination);
  });
  ipcMain.handle("attention-destination", (_event, source: string, id: string, destination: Destination) =>
    attention.setDestination(source, id, destination));
  ipcMain.handle("desktop-windows", () => desktop.listWindows());
  ipcMain.handle("is-dev-mode", () => Boolean(process.env.BREADITOR_DEV_MODE));
  ipcMain.on("set-title", (_event, title: string) => mainWindow.setTitle(String(title)));
  ipcMain.on("play-sound", (_event, id: string) => sendAudio("play-sound", String(id)));
  ipcMain.on("say-words", (_event, text: string) => {
    if (text) sendAudio("say-words", String(text).slice(0, 255));
  });
  ipcMain.on("open-sound-config", () => {
    const configPath = path.join(__dirname, "../../src/shared/sounds.json");
    if (require("fs").existsSync(configPath)) void shell.openPath(configPath);
  });
  mainWindow.webContents.on("did-start-loading", () => { rendererReady = false; });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    publish();
    for (const message of audioQueue.splice(0)) mainWindow.webContents.send(message.channel, message.value);
  });
  mainWindow.on("minimize", (event) => { event.preventDefault(); mainWindow.hide(); });
  mainWindow.on("close", (event) => {
    if (!quitting) { event.preventDefault(); mainWindow.hide(); }
  });
  tray?.on("click", () => mainWindow.isVisible() ? mainWindow.hide() : showInbox());
  app.on("second-instance", showInbox);
  await mainWindow.loadFile(path.join(__dirname, "../app/index.html"));
  if (process.env.BREADITOR_DEV_MODE) showInbox();
  if (process.env.WATCH_MODE === "true") require("./dev-watch").init();
  if (process.env.BREADITOR_DEV_MODE) require("./dev-mode").doInspectorSetupOnStart();
  publish();

  const server = createServer(Number(process.env.TRAY_PLATFORM_PORT || 22222), {
    apiHandler: createAttentionApi({ attention, desktop }),
    playSound: (id) => sendAudio("play-sound", id),
    sayWords: (text) => sendAudio("say-words", text),
  });
  app.on("before-quit", () => {
    quitting = true;
    unsubscribe();
    attention.close();
    desktop.close();
    server.close();
  });
  return { attention, desktop, mainWindow, server };
}) : Promise.resolve(undefined);

applicationReady.catch((error) => {
  console.error("Tray Platform startup failed:", error);
  app.exit(1);
});
