import * as sync from "fs";
import { promises as asyncFs } from "fs";
import { getWindow } from "./renderer-window";

console.log("dev-watch loaded...");

const _mainDir: string = "dist/main";
const _appDir: string = "dist/app";

const fileSizes: Map<string, number> = new Map(); // Keeps track of the last known sizes of files

async function prepopulateFileSizes(directory: string): Promise<void> {
	try {
		const files: string[] = await asyncFs.readdir(directory);
		for (const file of files) {
			const filePath: string = `${directory}/${file}`;
			try {
				const stats: sync.Stats = await asyncFs.stat(filePath);
				fileSizes.set(filePath, stats.size);
			} catch (err) {
				console.error(`Failed to get stats for file ${filePath}:`, err);
			}
		}
	} catch (err) {
		console.error(`Failed to read directory ${directory}:`, err);
	}
}

async function checkFileSizeAndAlert(filename: string): Promise<boolean> {
	try {
		const stats: sync.Stats = await asyncFs.stat(filename);
		const newSize: number = stats.size;
		const oldSize: number = fileSizes.get(filename) || 0;

		if (newSize == 0) {
			console.warn(`ignoring size 0 change on ${filename}`);
			return false;
		}

		fileSizes.set(filename, newSize);

		if (newSize !== oldSize) {
			return true;
		} else {
			return false;
		}
	} catch (err) {
		console.error(`Failed to get stats for file ${filename}:`, err);
		return false;
	}
}

let lastApp: number = new Date().getTime();
let lastMain: number = new Date().getTime();

let WAIT_IN_MS: number = 1000;

type WatchCallback = (filename: string) => void;

function watchDirectory(realDir: string, doOnHit: WatchCallback): void {
	console.log("setting up ", realDir);

	prepopulateFileSizes(realDir)
		.then(() => {
			console.log(`Prepopulated file sizes for ${realDir}:`, fileSizes);
			sync.watch(
				realDir,
				async (eventType: string, filename: string | null) => {
					if (filename) {
						const filePath: string = `${realDir}/${filename}`;

						checkFileSizeAndAlert(filePath).then((changed: boolean) => {
							if (changed) {
								const now: number = new Date().getTime();
								if (now - lastApp < WAIT_IN_MS) {
									return;
								} else {
									lastApp = now;
								}

								doOnHit(filePath);
							}
						});
					}
				},
			);
		})
		.catch((err: Error) =>
			console.error("Error prepopulating file sizes:", err)
		);
}

export const init = function init(): void {
	watchDirectory(_appDir, (filename: string) => {
		console.log("APP CHANGE", filename);
		getWindow().webContents.send("refresh-page", "APP");
	});

	watchDirectory(_mainDir, (filename: string) => {
		console.log("MAIN CHANGE", filename);

		getWindow().webContents.send(
			"say-words",
			"Main Process code is out of date. Please quit and restart",
		);

		getWindow().webContents.send(
			"show-alert",
			"Main Process code is out of date\n\nPlease quit and restart",
		);
	});
};

export default init;
