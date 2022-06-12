//const {app, BrowserWindow} = require('electron');
import {BrowserWindow, app} from 'electron';

let _window: BrowserWindow;

app.on('ready', (event) => {
  _window = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      // enableRemoteModule: true,
    },
  });
  _window.loadFile('dist/app/index.html'); // cwd is wherever you called `electron start` from.
});

//export {}; // to calm --isolatedModules's tits
