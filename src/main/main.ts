import { BrowserWindow, ipcMain, app, session, Tray } from 'electron';
import { setWindow } from './renderer-window';
import {doInspectorSetupOnStart} from './dev-mode';
import {setupTray} from './tray'
const path = require('node:path'); 

let tray:Tray;

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

  doInspectorSetupOnStart();

  tray = setupTray();
  // Show the window when the tray icon is clicked
  
  tray.on('click', function () {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  mainWindow.on('minimize', function (event) {
    event.preventDefault();
    mainWindow.hide();
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [''], // "default-src 'self' *" //'unsafe-inline', ???
      },
    });
  });

  ipcMain.on('set-title', (event, title) => {
    const webContents = event.sender
    let win = BrowserWindow.fromWebContents(webContents) as any
    (win as any).setTitle(title)
  })
});
