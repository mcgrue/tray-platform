const { app, Menu, Tray } = require("electron");
import { getWindowContents } from "./renderer-window";

export function setupTray(): Electron.CrossProcessExports.Tray | null {
  try {
    const appIcon = new Tray(__dirname + "/resources/tray-icon.png");
    const contextMenu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          {
            click: () => {
              try {
                getWindowContents().send("play-sound", "audio 1");
              } catch (e) {
                console.error(e);
              }
            },
            label: "Play Sound 1",
          },
          {
            click: () => getWindowContents().send("play-sound", "audio 2"),
            label: "Play Sound 2",
          },
          {
            click: () => getWindowContents().send("play-sound", "audio 3"),
            label: "Play Sound 3",
          },
          {
            click: () => getWindowContents().send("say-words", "butts"),
            label: "Say butts",
          },
        ],
      },
    ]);

    // Call this again for Linux because we modified the context menu
    appIcon.setContextMenu(contextMenu);
    return appIcon;
  } catch (e) {
    debugger;
    console.error(e);
  }

  return null;
}
