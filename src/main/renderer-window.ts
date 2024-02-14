import {BrowserWindow} from 'electron';

let _window: BrowserWindow;

export function setWindow(win:BrowserWindow) {
    _window = win;
}

export function getWindow() {
    return _window;
}

export function getWindowContents() : any {
    return _window.webContents as any;
}