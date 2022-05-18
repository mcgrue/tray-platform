//import { app, BrowserWindow } from "electron";

const { app, BrowserWindow } = require("electron");

let _window = null;

app.on('ready', (event) => {
	_window = new BrowserWindow();
});