import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import path from "path";
import { AttentionService } from "./attention-service";
import { createAttentionApi } from "./attention-api";
import { DesktopService } from "./desktop-service";
import { setWindow } from "./renderer-window";
import { setupTray, trayAlertImages, trayIconPath } from "./tray";
import { AttentionPresentation } from "./attention-presentation";
import { createServer } from "./webserver";
import { AttentionItem, AttentionState, canNavigateAttention, Destination, ShortcutKey } from "../shared/attention";
import { ShortcutService } from "./shortcut-service";
import { navigationDecision } from "./navigation";
import { BookmarkService } from "./bookmark-service";
import { createBookmarkApi } from "./bookmark-api";
import { BookmarkCaptureService } from "./bookmark-capture";
import { BookmarkCapture, BookmarkInput } from "../shared/bookmarks";
import { TitlebarController, titlebarConfig, titlebarWindowOptions } from "./titlebar";
import { TitlebarAction } from "../shared/titlebar";
import { CodexDiscovery } from "./codex-discovery";
import { CodexInstanceService } from "./codex-instance-service";
import { createCodexInstancesApi } from "./codex-instances-api";
import { CodexAttention } from "./codex-attention";
import { CodexMessageService } from "./codex-message-service";
import { CodexQuestionService } from "./codex-question-service";

require("dotenv").config();

// These overrides also allow isolated desktop smoke checks without touching live data.
if (process.env.TRAY_PLATFORM_USER_DATA) app.setPath("userData", process.env.TRAY_PLATFORM_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

export const applicationReady = singleInstance ? app.whenReady().then(async () => {
  let rendererReady = false;
  let quitting = false;
  let pendingNavigation: { error?: string } | undefined;
  let pendingCapture: BookmarkCapture | undefined;
  let pendingInboxReveal = false;
  const audioQueue: Array<{ channel: string; value: string }> = [];
  const titlebarSettings = titlebarConfig(process.env);
  const mainWindow = new BrowserWindow({
    width: 920,
    height: 760,
    show: false,
    icon: trayIconPath,
    ...titlebarWindowOptions(titlebarSettings, process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload_js.js"),
    },
  });
  const titlebar = new TitlebarController(mainWindow, titlebarSettings, process.platform);
  setWindow(mainWindow);
  const sendAudio = (channel: string, value: string) => {
    if (!rendererReady || mainWindow.isDestroyed()) audioQueue.push({ channel, value });
    else mainWindow.webContents.send(channel, value);
  };
  const attention = new AttentionService(path.join(app.getPath("userData"), "attention.json"), {
    onSound: (id) => sendAudio("play-sound", id),
  });
  await attention.initialize();
  const bookmarks = new BookmarkService(path.join(app.getPath("userData"), "bookmarks.json"), {
    attentionExists: (source, id) => Boolean(attention.get(source, id)),
  });
  await bookmarks.initialize();
  const desktop = new DesktopService({ openUrl: (link) => shell.openExternal(link), appPid: process.pid });
  const codexDiscovery = new CodexDiscovery(desktop);
  const codexInstances = new CodexInstanceService({ scan: () => codexDiscovery.scan() });
  const codexAttention = new CodexAttention(desktop, codexInstances);
  const codexMessages = new CodexMessageService();
  const codexQuestions = new CodexQuestionService(codexMessages);
  const unsubscribeCodex = codexInstances.onChanged(snapshot => {
    if (rendererReady && !mainWindow.isDestroyed()) mainWindow.webContents.send("codex-instances-changed", snapshot);
  });
  codexInstances.start();
  const showInbox = () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  const showNavigation = (error?: string) => {
    if (quitting || mainWindow.isDestroyed()) return;
    showInbox();
    if (!rendererReady) pendingNavigation = { error };
    else mainWindow.webContents.send("navigation-show", { error });
  };
  const capture = new BookmarkCaptureService({
    captureForeground: () => desktop.captureForeground(),
    showCapture: (context) => {
      if (quitting || mainWindow.isDestroyed()) return;
      showInbox();
      if (!rendererReady) pendingCapture = context;
      else mainWindow.webContents.send("bookmark-capture", context);
    },
  });
  const captureBookmarks = () => capture.request();
  const activateAttention = (item: AttentionItem) => codexAttention.activate(item, progress => {
    if (rendererReady && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("attention-navigation-progress", { source: item.source, id: item.id, ...progress });
    }
  });
  const goToPending = async (source: string, id: string) => {
    const item = attention.get(source, id);
    if (!item || item.state !== "pending") throw new Error("This item is no longer pending");
    await activateAttention(item);
  };
  let navigating = false;
  const navigatePending = async () => {
    if (navigating) return;
    navigating = true;
    try {
      const decision = navigationDecision(attention.list().items);
      if (decision.kind === "single" && canNavigateAttention(decision.item)) {
        await goToPending(decision.item.source, decision.item.id);
      } else showNavigation();
    } catch (error) { showNavigation(error instanceof Error ? error.message : String(error)); }
    finally { navigating = false; }
  };
  const shortcuts = new ShortcutService(path.join(app.getPath("userData"), "shortcuts.json"), globalShortcut, [
    { key: "navigate", defaultAccelerator: "Ctrl+Alt+Space", onInvoke: () => { void navigatePending(); } },
    { key: "capture", defaultAccelerator: "Ctrl+Alt+B", onInvoke: () => { void captureBookmarks(); } },
  ]);
  const tray = setupTray({ showInbox, navigate: () => { void navigatePending(); }, capture: () => { void captureBookmarks(); }, quit: () => app.quit() });
  const trayImages = trayAlertImages();
  const presentation = new AttentionPresentation({
    window: mainWindow,
    platform: process.platform,
    dock: process.platform === "darwin" ? app.dock : undefined,
    showPending: () => {
      if (!rendererReady) pendingInboxReveal = true;
      else mainWindow.webContents.send("attention-show");
    },
    setTrayAlert: active => {
      if (tray && !tray.isDestroyed()) tray.setImage(active ? trayImages.alert : trayImages.normal);
    },
    setTitlebarAlert: phase => titlebar.setAttentionPhase(phase),
  }, attention.list());
  mainWindow.on("focus", () => presentation.refreshFocus());
  mainWindow.on("blur", () => presentation.refreshFocus());
  mainWindow.on("hide", () => presentation.refreshFocus());
  const publish = () => {
    const snapshot = attention.list();
    const pending = snapshot.items.filter((item) => item.state === "pending").length;
    if (tray) tray.setToolTip(`Tray Platform — ${pending} pending${snapshot.error ? " — storage error" : ""}`);
    if (rendererReady && !mainWindow.isDestroyed()) mainWindow.webContents.send("attention-changed", snapshot);
  };
  const unsubscribe = attention.onChanged(snapshot => {
    publish();
    presentation.update(snapshot);
  });
  const unsubscribeShortcuts = shortcuts.onChanged((snapshot) => {
    if (rendererReady && !mainWindow.isDestroyed()) mainWindow.webContents.send("shortcuts-changed", snapshot);
  });
  const unsubscribeBookmarks = bookmarks.onChanged((snapshot) => {
    if (rendererReady && !mainWindow.isDestroyed()) mainWindow.webContents.send("bookmarks-changed", snapshot);
  });
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
    await activateAttention(item);
  });
  ipcMain.handle("attention-message", (event, source: string, id: string, message: string) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error("Messages must be sent from the attention inbox.");
    }
    return codexMessages.send(findItem(source, id), message);
  });
  const requireInbox = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error("Questions must be answered from the attention inbox.");
    }
  };
  ipcMain.handle("attention-question", (event, source: string, id: string) => {
    requireInbox(event);
    return codexQuestions.questions(findItem(source, id));
  });
  ipcMain.handle("attention-answer", async (event, source: string, id: string, answers: unknown) => {
    requireInbox(event);
    const receipt = await codexQuestions.answer(findItem(source, id), answers);
    if (receipt.remainingQuestions > 0) return receipt;
    try { await attention.setState(source, id, "done"); }
    catch { return { ...receipt, warning: "Answers were sent, but the Tray item could not be marked Done. Use Done when storage is available; do not resend." }; }
    return receipt;
  });
  ipcMain.handle("attention-destination", (_event, source: string, id: string, destination: Destination) =>
    attention.setDestination(source, id, destination));
  ipcMain.handle("desktop-windows", () => desktop.listWindows());
  ipcMain.handle("codex-instances-list", () => codexInstances.list());
  ipcMain.handle("codex-instances-refresh", () => codexInstances.refresh());
  ipcMain.handle("shortcuts-list", () => shortcuts.list());
  ipcMain.handle("shortcuts-set", (_event, key: ShortcutKey, accelerator: string) => shortcuts.set(key, accelerator));
  ipcMain.handle("navigation-run", () => navigatePending());
  ipcMain.handle("navigation-go", (_event, source: string, id: string) => goToPending(source, id));
  ipcMain.handle("bookmarks-list", () => bookmarks.list());
  ipcMain.handle("bookmarks-save", (_event, source: string, id: string, input: BookmarkInput) => bookmarks.saveHuman(source, id, input));
  ipcMain.handle("bookmarks-go", async (_event, source: string, id: string) => {
    const bookmark = bookmarks.get(source, id);
    if (!bookmark) throw new Error("Bookmark no longer exists");
    if (!bookmark.destination) throw new Error("This bookmark has no destination");
    await desktop.activate(bookmark.destination);
  });
  ipcMain.handle("bookmarks-capture", () => captureBookmarks());
  ipcMain.handle("is-dev-mode", () => Boolean(process.env.BREADITOR_DEV_MODE));
  ipcMain.on("set-title", (_event, title: string) => titlebar.setTitle(String(title)));
  ipcMain.handle("titlebar-get", () => titlebar.state());
  ipcMain.on("titlebar-action", (event, action: TitlebarAction) => {
    if (event.sender === mainWindow.webContents) titlebar.action(action);
  });
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
    if (pendingInboxReveal) {
      mainWindow.webContents.send("attention-show");
      pendingInboxReveal = false;
    }
    for (const message of audioQueue.splice(0)) mainWindow.webContents.send(message.channel, message.value);
    if (pendingNavigation) {
      mainWindow.webContents.send("navigation-show", pendingNavigation);
      pendingNavigation = undefined;
    }
    if (pendingCapture) {
      mainWindow.webContents.send("bookmark-capture", pendingCapture);
      pendingCapture = undefined;
    }
  });
  // Let native minimization keep the window available from the taskbar.
  mainWindow.on("close", (event) => {
    if (!quitting) { event.preventDefault(); mainWindow.hide(); }
  });
  tray?.on("click", () => mainWindow.isVisible() && mainWindow.isFocused() ? mainWindow.hide() : showInbox());
  tray?.on("double-click", showInbox);
  app.on("second-instance", showInbox);
  await mainWindow.loadFile(path.join(__dirname, "../app/index.html"));
  await shortcuts.initialize();
  showInbox();
  if (process.env.WATCH_MODE === "true") require("./dev-watch").init();
  if (process.env.BREADITOR_DEV_MODE) require("./dev-mode").doInspectorSetupOnStart();
  publish();

  const attentionApi = createAttentionApi({ attention, desktop, prepareInput: (source, input) => codexAttention.prepareInput(source, input) });
  const bookmarkApi = createBookmarkApi({ bookmarks });
  const codexApi = createCodexInstancesApi(codexInstances);
  const server = createServer(Number(process.env.TRAY_PLATFORM_PORT || 22222), {
    apiHandler: async (req, res) => await codexApi(req, res) || await bookmarkApi(req, res) || await attentionApi(req, res),
    playSound: (id) => sendAudio("play-sound", id),
    sayWords: (text) => sendAudio("say-words", text),
  });
  app.on("before-quit", () => {
    quitting = true;
    unsubscribe();
    presentation.close();
    unsubscribeShortcuts();
    unsubscribeBookmarks();
    unsubscribeCodex();
    codexInstances.close();
    codexDiscovery.close();
    codexMessages.close();
    shortcuts.close();
    attention.close();
    bookmarks.close();
    desktop.close();
    server.close();
  });
  return { attention, desktop, mainWindow, tray, server, shortcuts, navigatePending, bookmarks, captureBookmarks, codexInstances, codexMessages };
}) : Promise.resolve(undefined);

applicationReady.catch((error) => {
  console.error("Tray Platform startup failed:", error);
  app.exit(1);
});
