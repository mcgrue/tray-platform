// electron dev-infrastructure/smoke-titlebar.cjs
// Checks startup, native minimize/restore, then titlebar updates without taking focus.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app } = require("electron");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-titlebar-"));
app.setName("Tray titlebar smoke " + process.pid);
app.setPath("userData", dataPath);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "",
  TRAY_PLATFORM_TITLEBAR_ACTIVE_COLOR: "#ff0000", TRAY_PLATFORM_TITLEBAR_INACTIVE_COLOR: "#0000ff" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(30); }
  throw new Error("Timeout: " + label);
}

async function run() {
  const { mainWindow } = await require("../dist/main/index.js").applicationReady;
  const evaluate = fn => mainWindow.webContents.executeJavaScript(`(${fn.toString()})()`);
  const read = () => evaluate(() => {
    const bar = document.getElementById("app-titlebar");
    return { title: bar.querySelector("[data-titlebar-label]").textContent, color: getComputedStyle(bar).backgroundColor,
      textColor: getComputedStyle(bar).color, focused: bar.dataset.focused,
      height: bar.getBoundingClientRect().height, controlsHidden: bar.querySelector("[data-titlebar-controls]").hidden };
  });
  await waitFor("prefixed titlebar", async () => (await read()).title === "smoketest - Tray Platform");
  assert.equal(mainWindow.isVisible(), true, "Startup opens the attention inbox");
  mainWindow.minimize();
  await waitFor("native minimization", () => mainWindow.isMinimized());
  assert.equal(mainWindow.isVisible(), true, "Minimization retains the taskbar window");
  mainWindow.restore();
  mainWindow.focus();
  await waitFor("restored inbox takes focus", () => mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused());
  mainWindow.hide();
  await waitFor("hidden inbox loses focus", async () => !mainWindow.isFocused() && (await read()).focused === "false");
  const check = async focused => {
    const state = await read();
    assert.equal(state.title, mainWindow.getTitle());
    assert.equal(state.color, "rgb(75, 83, 32)");
    assert.equal(state.textColor, "rgb(255, 255, 255)");
    assert.equal(state.focused, String(focused)); assert.equal(state.height, 36);
    assert.equal(state.controlsHidden, ["win32", "darwin"].includes(process.platform));
  };
  for (const method of ["show", "focus", "restore"]) mainWindow[method] = () => { throw new Error("Titlebar must not activate via " + method); };
  const overlays = [];
  if (process.platform === "win32") {
    const setOverlay = mainWindow.setTitleBarOverlay.bind(mainWindow);
    mainWindow.setTitleBarOverlay = options => { overlays.push(options); setOverlay(options); };
  }
  await check(false);
  mainWindow.showInactive();
  assert.equal(mainWindow.isFocused(), false);
  // Deliver both focus events without moving the user's actual OS focus.
  mainWindow.emit("focus");
  await waitFor("active color", async () => (await read()).focused === "true");
  await check(true);
  mainWindow.emit("blur");
  await waitFor("inactive color", async () => (await read()).focused === "false");
  await check(false);
  if (process.platform === "win32") {
    assert(overlays.length >= 2);
    assert(overlays.every(value => value.color === "#4b5320" && value.symbolColor === "#ffffff"));
  }
  await evaluate(() => { document.title = "Attention Inbox"; });
  await waitFor("document title prefix", async () => (await read()).title === "smoketest - Attention Inbox");
  await check(false);
  await evaluate(() => window.ipcComms.setTitle("smoketest - IPC title"));
  await waitFor("IPC title prefix", async () => (await read()).title === "smoketest - IPC title");
  await check(false);
  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("reload title prefix", async () => (await read()).title === "smoketest - Tray Platform");
  await check(false);
  const screenshot = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(dataPath, "titlebar.png"), screenshot.toPNG());
  assert.equal(mainWindow.isFocused(), false);
  mainWindow.close();
  assert.equal(mainWindow.isDestroyed(), false, "Close retains the existing hide-to-tray behavior");
  assert.equal(mainWindow.isVisible(), false);
  console.log("PASS: startup opens the inbox; minimize retains the taskbar window; restore focuses; olive titlebar and native overlay agree; smoke prefix survives document/IPC updates and reload; close hides; titlebar updates do not take focus.");
  console.log(JSON.stringify({ dataPath, overlays: overlays.length }));
}

let failed = false;
const watchdog = setTimeout(() => { console.error("Titlebar smoke timed out"); app.exit(1); }, 45000);
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
