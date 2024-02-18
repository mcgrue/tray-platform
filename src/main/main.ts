import { BrowserWindow, ipcMain, app, session, Tray } from "electron";
import { setWindow } from "./renderer-window";
import { doInspectorSetupOnStart } from "./dev-mode";
import { setupTray } from "./tray";
import { createServer } from "./webserver";
const dotenv = require("dotenv").config();
const path = require("node:path");

let tray: Tray;

let server = createServer(22222);

app.on("ready", (event) => {
  const mainWindow = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: true,
      preload: path.join(__dirname, "preload_js.js"),
    },
  });

  // mainWindow.setMenu(null); // No system menu.
  mainWindow.loadFile("dist/app/index.html"); // cwd is wherever you called `electron start` from.
  setWindow(mainWindow);

  doInspectorSetupOnStart();

  tray = setupTray();
  // Show the window when the tray icon is clicked

  tray.on("click", function () {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  mainWindow.on("minimize", function (event) {
    event.preventDefault();
    mainWindow.hide();
  });

  if (dotenv.parsed && !dotenv.parsed.BREADITOR_DEV_MODE) {
    mainWindow.hide();
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [""], // "default-src 'self' *" //'unsafe-inline', ???
      },
    });
  });

  ipcMain.on("set-title", (event, title) => {
    const webContents = event.sender;
    let win = BrowserWindow.fromWebContents(webContents) as any;
    (win as any).setTitle(title);
  });

  ipcMain.on("play-sound", (event, soundName) => {
    const webContents = event.sender;
    let win = BrowserWindow.fromWebContents(webContents) as any;
    (win as any).playSound(soundName);
  });

  ipcMain.on("say-words", (event, text: string) => {
    if (text.length == 0) {
      return;
    }

    if (text.length > 255) {
      text = text.substring(0, 255);
    }

    const webContents = event.sender;
    let win = BrowserWindow.fromWebContents(webContents) as any;
    (win as any).sayWords(text);
  });
});
