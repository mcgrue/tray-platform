const {app, BrowserWindow} = require('electron');
// import { app, BrowserWindow } from "electron";

let _window = null;

app.on('ready', (event) => {
  _window = new BrowserWindow();
  _window.loadFile('dist/app/index.html'); // cwd is wherever you called `electron start` from.
});
