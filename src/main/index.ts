import { BrowserWindow, ipcMain, app } from 'electron';
import { setWindow, getWindowContents } from './renderer-window';
const path = require('node:path'); 

import init from './dev-watch'
init();

console.log('__dirname', __dirname);

app.on('ready', (event) => {
  const _window = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload_js.js'),
      // contextIsolation: true,
    },
  });
  
  _window.loadFile('dist/app/index.html'); // cwd is wherever you called `electron start` from.
  setWindow(_window);

  ipcMain.on('set-title', (event, title) => {
    const webContents = event.sender
    let win = BrowserWindow.fromWebContents(webContents) as any
    (win as any).setTitle(title)
  })
});
