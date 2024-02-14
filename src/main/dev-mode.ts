import { BrowserWindow } from 'electron';
import { getWindow } from './renderer-window'
import { init } from './dev-watch';

const dotenv = require('dotenv').config();

if(dotenv.parsed && dotenv.parsed.BREADITOR_DEV_MODE)
{
    init();
}

export function doInspectorSetupOnStart() 
{
    if (dotenv.parsed && dotenv.parsed.BREADITOR_DEV_MODE) {
        
        const mainWindow = getWindow();
        const devtoolsWindow = new BrowserWindow();

        mainWindow.webContents.setDevToolsWebContents(devtoolsWindow.webContents);
        mainWindow.webContents.openDevTools({ mode: 'detach' });

        // Set the devtools position when the parent window has finished loading.
        mainWindow.webContents.once('did-finish-load', function () {
            console.log('Main window did-finish-load.');

            if (
                dotenv.parsed.MAIN_WINDOW_X != undefined &&
                dotenv.parsed.MAIN_WINDOW_Y != undefined &&
                dotenv.parsed.MAIN_WINDOW_W != undefined &&
                dotenv.parsed.MAIN_WINDOW_H != undefined
            ) {
                console.log('Main window set size.');

                const x = parseInt(dotenv.parsed.MAIN_WINDOW_X, 10);
                const y = parseInt(dotenv.parsed.MAIN_WINDOW_Y, 10);
                const w = parseInt(dotenv.parsed.MAIN_WINDOW_W, 10);
                const h = parseInt(dotenv.parsed.MAIN_WINDOW_H, 10);

                mainWindow.setPosition(x, y);
                mainWindow.setSize(w, h);
            }
        });

        devtoolsWindow.webContents.once('did-finish-load', function () {
            console.log('devtoolsWindow did-finish-load.');
            if (
                dotenv.parsed.INSPECTOR_WINDOW_X != undefined &&
                dotenv.parsed.INSPECTOR_WINDOW_Y != undefined &&
                dotenv.parsed.INSPECTOR_WINDOW_W != undefined &&
                dotenv.parsed.INSPECTOR_WINDOW_H != undefined
            ) {
                console.log('devtoolsWindow set size.');

                const x = parseInt(dotenv.parsed.INSPECTOR_WINDOW_X, 10);
                const y = parseInt(dotenv.parsed.INSPECTOR_WINDOW_Y, 10);
                const w = parseInt(dotenv.parsed.INSPECTOR_WINDOW_W, 10);
                const h = parseInt(dotenv.parsed.INSPECTOR_WINDOW_H, 10);

                devtoolsWindow.setPosition(x, y);
                devtoolsWindow.setSize(w, h);
            }
        });

        console.log('Lol, Development.');
    } else {
        console.log('Lol, Production.');
    }
      
}