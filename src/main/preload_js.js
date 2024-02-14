const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('ipcComms', {
  // send's go to the main process
  setTitle: (title) => ipcRenderer.send('set-title', title),

  // on's come from the main process
  onShowAlert: (callback) => ipcRenderer.on('show-alert', (_event, value) => callback(value)),
  onRefreshPage: (callback) => ipcRenderer.on('refresh-page', (_event, value) => callback(value)),
})