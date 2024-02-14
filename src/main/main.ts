import { BrowserWindow, ipcMain, app, session } from 'electron';
import { setWindow } from './renderer-window';
import {doInspectorSetupOnStart} from './dev-mode';
const path = require('node:path'); 

console.log('__dirname', __dirname);

app.on('ready', (event) => {
  const mainWindow = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload_js.js'),
    },
  });
  // mainWindow.setMenu(null); // No system menu.
  mainWindow.loadFile('dist/app/index.html'); // cwd is wherever you called `electron start` from.
  setWindow(mainWindow);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [''], // "default-src 'self' *" //'unsafe-inline', ???
      },
    });
  });

  doInspectorSetupOnStart();

  ipcMain.on('set-title', (event, title) => {
    const webContents = event.sender
    let win = BrowserWindow.fromWebContents(webContents) as any
    (win as any).setTitle(title)
  })
});
