// Windows: electron dev-infrastructure/smoke-attention-presentation.cjs
// Exercises pending titlebar/tray signals, real native visibility and foreground preservation.
// Uses retained isolated data. After startup, notifications never call show(), focus(), or restore().
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app } = require("electron");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-attention-presentation-"));
app.setName("Tray attention presentation smoke " + process.pid);
app.setPath("userData", dataPath);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
fs.writeFileSync(path.join(dataPath, "attention.json"), JSON.stringify({ version: 1, items: [
  { source: "smoke", id: "saved", title: "Saved pending work", state: "pending", createdAt: 1, updatedAt: 1 },
] }));
const palette = ["#d69e2e", "#805ad5", "#0f766e"];
const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(30); }
  throw new Error("Timeout: " + label);
}

async function run() {
  assert.equal(process.platform, "win32", "Native foreground checks use the Windows desktop helper");
  const { mainWindow, tray, server, attention, desktop } = await require("../dist/main/index.js").applicationReady;
  assert(tray, "Native tray icon was created");
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const titlebar = () => evaluate(async () => {
    const bar = document.getElementById("app-titlebar");
    return { ...await window.ipcComms.getTitlebar(), renderedColor: getComputedStyle(bar).backgroundColor,
      renderedText: getComputedStyle(bar).color };
  });
  const hasAlertColor = async () => {
    const state = await titlebar();
    return palette.includes(state.color) && state.renderedColor === rgb(state.color);
  };
  await waitFor("inbox", () => evaluate(() => Boolean(document.querySelector("main nav"))));
  await evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  assert.equal(mainWindow.isVisible(), true, "Startup opens the attention inbox");
  await waitFor("saved pending items signal on startup", hasAlertColor);
  await attention.setState("smoke", "saved", "done");
  await waitFor("saved item resolved restores idle titlebar", async () => (await titlebar()).renderedColor === rgb("#4b5320"));
  mainWindow.hide();
  await waitFor("hidden inbox loses focus", () => !mainWindow.isVisible() && !mainWindow.isFocused());
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const foreground = await desktop.captureForeground();
  assert(foreground, "Another application is foreground for the no-focus test");
  const forbidden = [], images = [], flashes = [], overlays = [];
  let activations = 0, reveals = 0, syntheticFocus = false;
  mainWindow.on("focus", () => { if (!syntheticFocus) activations++; });
  for (const method of ["show", "focus", "restore"]) mainWindow[method] = () => {
    forbidden.push(method); throw new Error("Automatic notifications must not call " + method);
  };
  const showInactive = mainWindow.showInactive.bind(mainWindow);
  mainWindow.showInactive = () => { reveals++; showInactive(); };
  const setImage = tray.setImage.bind(tray);
  tray.setImage = image => { images.push(image.toPNG()); setImage(image); };
  const flashFrame = mainWindow.flashFrame.bind(mainWindow);
  mainWindow.flashFrame = flag => { flashes.push(flag); flashFrame(flag); };
  const setOverlay = mainWindow.setTitleBarOverlay.bind(mainWindow);
  mainWindow.setTitleBarOverlay = options => { overlays.push(options); setOverlay(options); };
  const put = id => new Promise((resolve, reject) => {
    const body = JSON.stringify({ title: "Presentation test " + id });
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
      path: "/api/attention/smoke/" + id, method: "PUT", headers: { "Content-Type": "application/json" } }, res => {
      res.resume(); res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("HTTP " + res.statusCode)));
    });
    req.on("error", reject); req.end(body);
  });
  const pending = () => evaluate(() => document.querySelector('main nav button[aria-pressed="true"]')?.textContent.startsWith("Pending"));
  const noFocus = async (stage = "notification") => {
    assert.equal(mainWindow.isFocused(), false);
    assert.equal(activations, 0, "No transient focus activation");
    assert.deepEqual(forbidden, []);
    const actual = await desktop.captureForeground();
    assert.equal(actual?.hwnd, foreground.hwnd, `OS foreground remains unchanged after ${stage}: ${JSON.stringify({ expected: foreground, actual })}`);
  };
  assert.equal(mainWindow.isVisible(), false);
  await evaluate(() => Array.from(document.querySelectorAll("main nav button")).find(node => node.textContent.startsWith("Done")).click());
  await put("first");
  await waitFor("hidden inbox opens on Pending", async () => mainWindow.isVisible() && await pending());
  assert.equal(reveals, 1); assert.deepEqual(flashes, [true]);
  await noFocus();
  await put("second");
  await waitFor("tray blink alternates native images", () => images.length >= 3);
  assert(!images[0].equals(images[1])); assert(images[0].equals(images[2]));
  assert.deepEqual(flashes, [true]); assert.equal(reveals, 1);
  await noFocus();
  for (const color of palette) {
    await waitFor("rendered and native titlebar phase " + color, async () => {
      const state = await titlebar(), overlay = overlays[overlays.length - 1];
      return state.color === color && state.renderedColor === rgb(color) &&
        overlay?.color === color && overlay.symbolColor === state.textColor && state.renderedText === rgb(state.textColor);
    });
    const screenshot = await mainWindow.webContents.capturePage();
    assert(!screenshot.isEmpty(), "Visible titlebar screenshot contains pixels");
    fs.writeFileSync(path.join(dataPath, "titlebar-" + color.slice(1) + ".png"), screenshot.toPNG());
  }
  await put("second");
  assert.deepEqual(flashes, [true]); assert.equal(reveals, 1);
  await attention.setState("smoke", "second", "done");
  assert.deepEqual(flashes, [true]);
  let frames = images.length;
  await waitFor("older pending item keeps tray cycling", () => images.length > frames);
  assert.equal(attention.get("smoke", "first").state, "pending");
  await noFocus();
  // Exercise the focus handlers without moving the user's actual OS focus.
  const isFocused = mainWindow.isFocused.bind(mainWindow);
  try {
    syntheticFocus = true;
    mainWindow.isFocused = () => true;
    mainWindow.emit("focus");
    assert.equal(flashes[flashes.length - 1], false, "Focus pauses native taskbar attention");
    frames = images.length;
    await waitFor("focused inbox keeps tray and titlebar cycling", async () => images.length > frames && await hasAlertColor());
    assert.equal(flashes[flashes.length - 1], false);
  } finally {
    mainWindow.isFocused = isFocused;
    mainWindow.emit("blur");
    syntheticFocus = false;
  }
  assert.equal(flashes[flashes.length - 1], true, "Native attention resumes on blur");
  await noFocus();
  await put("third");
  assert.equal(flashes[flashes.length - 1], true);
  mainWindow.hide();
  assert.equal(flashes[flashes.length - 1], true, "Hiding preserves pending attention");
  frames = images.length;
  await waitFor("hidden inbox keeps cycling", async () => images.length > frames && await hasAlertColor());
  await put("fourth");
  await waitFor("hidden inbox reopens", () => mainWindow.isVisible());
  assert.equal(reveals, 2);
  await noFocus();
  mainWindow.minimize();
  await waitFor("inbox minimizes normally", () => mainWindow.isMinimized());
  assert.equal(mainWindow.isVisible(), true, "Minimization retains the taskbar window");
  await noFocus("minimize");
  await put("fifth");
  await waitFor("minimized inbox opens inactive", () => mainWindow.isVisible() && !mainWindow.isMinimized());
  assert.equal(reveals, 3);
  await noFocus("minimized arrival");
  await waitFor("restored titlebar is rendered", hasAlertColor);
  const screenshot = await mainWindow.webContents.capturePage();
  assert(!screenshot.isEmpty(), "Restored inbox screenshot contains pixels");
  fs.writeFileSync(path.join(dataPath, "inbox.png"), screenshot.toPNG());
  fs.writeFileSync(path.join(dataPath, "tray-alert.png"), images[0]);
  fs.writeFileSync(path.join(dataPath, "tray-normal.png"), images[1]);
  mainWindow.hide();
  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("reloaded pending titlebar", hasAlertColor);
  assert.equal(mainWindow.isVisible(), false, "Renderer reload does not replay old arrivals");
  assert.equal(reveals, 3);
  frames = images.length;
  await waitFor("reload keeps the pending signal", () => images.length > frames);
  await noFocus();
  for (const id of ["first", "third", "fourth"]) await attention.setState("smoke", id, "done");
  assert.equal(flashes[flashes.length - 1], true, "Last pending item still signals");
  await attention.setState("smoke", "fifth", "snoozed", 5);
  await waitFor("no pending items restores titlebar", async () => {
    const state = await titlebar();
    return state.color === "#4b5320" && state.renderedColor === rgb(state.color) && state.renderedText === rgb("#ffffff");
  });
  assert.equal(flashes[flashes.length - 1], false);
  assert.deepEqual(overlays[overlays.length - 1], { color: "#4b5320", symbolColor: "#ffffff" });
  assert(images[images.length - 1].equals(images[1]), "Normal tray icon restored");
  const stopped = { frames: images.length, overlays: overlays.length };
  await sleep(1200);
  assert.equal(images.length, stopped.frames);
  assert.equal(overlays.length, stopped.overlays);
  await noFocus();
  // Exercise explicit tray-click routing with non-activating stubs: an inactive
  // visible inbox should be raised on click, not hidden by the old toggle rule.
  showInactive();
  const explicit = [];
  mainWindow.show = () => explicit.push("show");
  mainWindow.focus = () => explicit.push("focus");
  tray.emit("click");
  assert.deepEqual(explicit, ["show", "focus"]);
  assert.equal(mainWindow.isVisible(), true);
  mainWindow.hide();
  console.log("PASS: saved and new pending items cycle rendered/native titlebar colors and tray images; focus/hide/reload preserve signals; native attention pauses on focus; last pending item snoozed restores idle appearance; hidden/minimized arrivals open inactive; no OS focus change.");
  console.log(JSON.stringify({ dataPath, reveals, activations, trayFrames: images.length, overlays: overlays.length, flashes }));
}

let failed = false;
const watchdog = setTimeout(() => { console.error("Presentation smoke timed out"); app.exit(1); }, 90000);
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
