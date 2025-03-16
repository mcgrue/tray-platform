const { app, Menu, Tray } = require("electron");
import soundConfig from "../shared/sounds.json";
import { type SoundConfig } from "../shared/types";
import { getWindowContents } from "./renderer-window";

const sounds = (soundConfig as SoundConfig).sounds;

debugger;

export function setupTray(): Electron.CrossProcessExports.Tray | null {
	try {
		const appIcon = new Tray(__dirname + "/resources/tray-icon.png");

		// Create menu items for each sound
		const soundMenuItems = Object.entries(sounds).map(([key, sound]) => ({
			label: `Play ${key}`,
			click: () => getWindowContents().send("play-sound", sound.id),
		}));

		const contextMenu = Menu.buildFromTemplate([
			{
				label: app.name,
				submenu: [
					...soundMenuItems,
					{
						click: () => getWindowContents().send("say-words", "Hello!"),
						label: "Say Hello",
					},
				],
			},
		]);

		appIcon.setContextMenu(contextMenu);
		return appIcon;
	} catch (e) {
		console.error(e);
		return null;
	}
}
