const { app, Menu, Tray, nativeImage } = require("electron");
import soundConfig from "../shared/sounds.json";
import { type SoundConfig } from "../shared/types";
import { getWindowContents } from "./renderer-window";

const sounds = (soundConfig as SoundConfig).sounds;

export function trayAlertImages() {
	// A high-contrast amber alert alternates with the normal tray icon. Keep the
	// icon present and clickable throughout the blink cycle.
	const pixels = Buffer.alloc(16 * 16 * 4);
	for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
		const mark = x >= 7 && x <= 8 && ((y >= 4 && y <= 9) || y === 12);
		const offset = (y * 16 + x) * 4;
		pixels[offset] = 0x00;
		pixels[offset + 1] = mark ? 0 : 0xbf;
		pixels[offset + 2] = mark ? 0 : 0xff;
		pixels[offset + 3] = 0xff;
	}
	return {
		normal: nativeImage.createFromPath(__dirname + "/resources/tray-icon.png"),
		alert: nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }),
	};
}

export function setupTray(options: { showInbox: () => void; navigate: () => void; capture: () => void; quit: () => void }): Electron.CrossProcessExports.Tray | null {
	try {
		const appIcon = new Tray(__dirname + "/resources/tray-icon.png");

		// Create menu items for each sound
		const soundMenuItems = Object.entries(sounds).map(([key, sound]) => ({
			label: `Play ${key}`,
			click: () => getWindowContents().send("play-sound", sound.id),
		}));

		const contextMenu = Menu.buildFromTemplate([
			{ label: "Open attention inbox", click: options.showInbox },
			{ label: "Take me there", click: options.navigate },
			{ label: "Capture context bookmark", click: options.capture },
			{ type: "separator" },
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
			{ type: "separator" },
			{ label: "Quit Tray Platform", click: options.quit },
		]);

		appIcon.setContextMenu(contextMenu);
		return appIcon;
	} catch (e) {
		console.error(e);
		return null;
	}
}
