const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld("ipcComms", {
  // send's go to the main process
  setTitle: (title) => ipcRenderer.send("set-title", title),
  playSound: (id) => ipcRenderer.send("play-sound", id),

  // on's come from the main process
  onShowAlert: (callback) =>
    ipcRenderer.on("show-alert", (_event, value) => callback(value)),
  onRefreshPage: (callback) =>
    ipcRenderer.on("refresh-page", (_event, value) => callback(value)),
  onPlaySound: (callback) =>
    ipcRenderer.on("play-sound", (_event, value) => callback(value)),
  onSayWords: (callback) =>
    ipcRenderer.on("say-words", (_event, value) => callback(value)),
});
