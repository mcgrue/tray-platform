const { contextBridge, ipcRenderer } = require("electron/renderer");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("ipcComms", {
  getCodexInstances: () => ipcRenderer.invoke("codex-instances-list"),
  refreshCodexInstances: () => ipcRenderer.invoke("codex-instances-refresh"),
  onCodexInstancesChanged: (callback) => subscribe("codex-instances-changed", callback),
  getTitlebar: () => ipcRenderer.invoke("titlebar-get"),
  onTitlebarChanged: (callback) => subscribe("titlebar-changed", callback),
  titlebarAction: (action) => ipcRenderer.send("titlebar-action", action),
  getBookmarks: () => ipcRenderer.invoke("bookmarks-list"),
  saveBookmark: (source, id, input) => ipcRenderer.invoke("bookmarks-save", source, id, input),
  goToBookmark: (source, id) => ipcRenderer.invoke("bookmarks-go", source, id),
  captureBookmark: () => ipcRenderer.invoke("bookmarks-capture"),
  onBookmarksChanged: (callback) => subscribe("bookmarks-changed", callback),
  onCaptureBookmark: (callback) => subscribe("bookmark-capture", callback),
  getShortcuts: () => ipcRenderer.invoke("shortcuts-list"),
  setShortcut: (key, accelerator) => ipcRenderer.invoke("shortcuts-set", key, accelerator),
  navigatePending: () => ipcRenderer.invoke("navigation-run"),
  goToPending: (source, id) => ipcRenderer.invoke("navigation-go", source, id),
  onShortcutsChanged: (callback) => subscribe("shortcuts-changed", callback),
  onShowNavigation: (callback) => subscribe("navigation-show", callback),
  getAttention: () => ipcRenderer.invoke("attention-list"),
  setAttentionState: (source, id, state, minutes) => ipcRenderer.invoke("attention-state", source, id, state, minutes),
  goToAttention: (source, id) => ipcRenderer.invoke("attention-go", source, id),
  setAttentionDestination: (source, id, destination) => ipcRenderer.invoke("attention-destination", source, id, destination),
  listWindows: () => ipcRenderer.invoke("desktop-windows"),
  onAttentionChanged: (callback) => subscribe("attention-changed", callback),
  onAttentionNavigationProgress: (callback) => subscribe("attention-navigation-progress", callback),
  onShowAttention: (callback) => subscribe("attention-show", callback),
  // send's go to the main process
  setTitle: (title) => ipcRenderer.send("set-title", title),
  playSound: (id) => ipcRenderer.send("play-sound", id),
  openSoundConfig: () => ipcRenderer.send("open-sound-config"),
  isDevMode: () => ipcRenderer.invoke("is-dev-mode"),

  // on's come from the main process
  onShowAlert: (callback) => subscribe("show-alert", callback),
  onRefreshPage: (callback) => subscribe("refresh-page", callback),
  onPlaySound: (callback) => subscribe("play-sound", callback),
  onSayWords: (callback) => subscribe("say-words", callback),
});
