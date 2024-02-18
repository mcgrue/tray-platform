import { getWindow } from "./renderer-window";
import * as sync from "fs";
import { promises as asyncFs } from "fs";

console.log("dev-watch loaded...");

const _mainDir = "dist/main";
const _appDir = "dist/app";

const fileSizes = new Map(); // Keeps track of the last known sizes of files

async function prepopulateFileSizes(directory) {
  try {
    const files = await asyncFs.readdir(directory); // Read all files in the directory
    for (const file of files) {
      const filePath = `${directory}/${file}`;
      try {
        const stats = await asyncFs.stat(filePath);
        fileSizes.set(filePath, stats.size); // Populate the map with file size
      } catch (err) {
        console.error(`Failed to get stats for file ${filePath}:`, err);
      }
    }
  } catch (err) {
    console.error(`Failed to read directory ${directory}:`, err);
  }
}

async function checkFileSizeAndAlert(filename) {
  try {
    const stats = await asyncFs.stat(filename);
    const newSize = stats.size;
    const oldSize = fileSizes.get(filename) || 0;

    if (newSize == 0) {
      console.warn(`ignoring size 0 change on ${filename}`);
      return false;
    }

    fileSizes.set(filename, newSize); // Update the stored size

    if (newSize !== oldSize) {
      // console.log(`File size CHANGED for ${filename}: old size = ${oldSize}, new size = ${newSize}`);
      return true; // File size has changed
    } else {
      // console.log(`File size NOT changed for ${filename}: old size = ${oldSize}, new size = ${newSize}`);
      return false; // File size has not changed
    }
  } catch (err) {
    console.error(`Failed to get stats for file ${filename}:`, err);
    return false; // Treat errors as "no change" for simplicity
  }
}

let lastApp = new Date().getTime();
let lastMain = new Date().getTime();

let WAIT_IN_MS = 1000;

function watchDirectory(realDir, doOnHit) {
  console.log("setting up ", realDir);

  prepopulateFileSizes(realDir)
    .then(() => {
      console.log(`Prepopulated file sizes for ${realDir}:`, fileSizes);
      // Now, you can start watching the directory for changes
      sync.watch(realDir, async (eventType, filename) => {
        if (filename) {
          const filePath = `${realDir}/${filename}`;

          checkFileSizeAndAlert(filePath).then((changed) => {
            if (changed) {
              const now = new Date().getTime();
              if (now - lastApp < WAIT_IN_MS) {
                return;
              } else {
                lastApp = now;
              }

              doOnHit(filePath);
            }
          });
        }
      });
    })
    .catch((err) => console.error("Error prepopulating file sizes:", err));
}

export const init = function init() {
  watchDirectory(_appDir, (filename) => {
    console.log("APP CHANGE", filename);

    // getWindow().webContents.send('set-tile', "APP")
    getWindow().webContents.send("refresh-page", "APP");
  });

  watchDirectory(_mainDir, (filename) => {
    console.log("MAIN CHANGE", filename);

    getWindow().webContents.send(
      "show-alert",
      "Main Process code is out of date\n\nPlease quit and restart",
    );
  });
};

export default init;
