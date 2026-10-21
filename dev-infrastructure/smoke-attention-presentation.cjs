// Windows: electron dev-infrastructure/smoke-attention-presentation.cjs
// Exercises real native visibility, tray images and foreground preservation.
// Uses retained isolated data. Never calls show(), focus(), or restore().
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app } = require("electron");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-attention-presentation-"));
app.setName("Tray attention presentation smoke " + process.pid);
app.setPath("userData", dataPath);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
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
  await waitFor("inbox", () => evaluate(() => Boolean(document.querySelector("main nav"))));
  await evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const foreground = await desktop.captureForeground();
  assert(foreground, "Another application is foreground for the no-focus test");
  const forbidden = [], images = [], flashes = [];
  let activations = 0, reveals = 0;
  mainWindow.on("focus", () => { activations++; });
  for (const method of ["show", "focus", "restore"]) mainWindow[method] = () => {
    forbidden.push(method); throw new Error("Automatic notifications must not call " + method);
  };
  const showInactive = mainWindow.showInactive.bind(mainWindow);
  mainWindow.showInactive = () => { reveals++; showInactive(); };
  const setImage = tray.setImage.bind(tray);
  tray.setImage = image => { images.push(image.toPNG()); setImage(image); };
  const flashFrame = mainWindow.flashFrame.bind(mainWindow);
  mainWindow.flashFrame = flag => { flashes.push(flag); flashFrame(flag); };
  const put = id => new Promise((resolve, reject) => {
    const body = JSON.stringify({ title: "Presentation test " + id });
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
      path: "/api/attention/smoke/" + id, method: "PUT", headers: { "Content-Type": "application/json" } }, res => {
      res.resume(); res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("HTTP " + res.statusCode)));
    });
    req.on("error", reject); req.end(body);
  });
  const pending = () => evaluate(() => document.querySelector('main nav button[aria-pressed="true"]')?.textContent.startsWith("Pending"));
  const noFocus = async () => {
    assert.equal(mainWindow.isFocused(), false);
    assert.equal(activations, 0, "No transient focus activation");
    assert.deepEqual(forbidden, []);
    assert.equal((await desktop.captureForeground())?.hwnd, foreground.hwnd, "OS foreground remains unchanged");
  };
  assert.equal(mainWindow.isVisible(), false);
  await evaluate(() => Array.from(document.querySelectorAll("main nav button")).find(node => node.textContent.startsWith("Done")).click());
  await put("first");
  await waitFor("hidden inbox opens on Pending", async () => mainWindow.isVisible() && await pending());
  assert.equal(reveals, 1); assert.deepEqual(flashes, []);
  await noFocus();
  await put("second");
  await waitFor("tray blink alternates native images", () => images.length >= 3);
  assert(!images[0].equals(images[1])); assert(images[0].equals(images[2]));
  assert.deepEqual(flashes, [true]); assert.equal(reveals, 1);
  await noFocus();
  await put("second");
  assert.deepEqual(flashes, [true]); assert.equal(reveals, 1);
  await attention.setState("smoke", "second", "done");
  assert.deepEqual(flashes, [true, false]);
  const stopped = images.length; await sleep(600); assert.equal(images.length, stopped);
  assert.equal(attention.get("smoke", "first").state, "pending");
  await noFocus();
  await put("third");
  assert.equal(flashes[flashes.length - 1], true);
  mainWindow.hide();
  assert.equal(flashes[flashes.length - 1], false, "Hiding acknowledges the signal");
  await put("fourth");
  await waitFor("hidden inbox reopens", () => mainWindow.isVisible());
  assert.equal(reveals, 2);
  await noFocus();
  mainWindow.minimize();
  await waitFor("minimize hides inbox", () => !mainWindow.isVisible());
  await put("fifth");
  await waitFor("minimized inbox opens inactive", () => mainWindow.isVisible() && !mainWindow.isMinimized());
  assert.equal(reveals, 3);
  await noFocus();
  const screenshot = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(dataPath, "inbox.png"), screenshot.toPNG());
  fs.writeFileSync(path.join(dataPath, "tray-alert.png"), images[0]);
  fs.writeFileSync(path.join(dataPath, "tray-normal.png"), images[1]);
  mainWindow.hide();
  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await sleep(100);
  assert.equal(mainWindow.isVisible(), false, "Renderer reload does not replay old arrivals");
  assert.equal(reveals, 3);
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
  console.log("PASS: hidden/minimized inbox opens on Pending; visible inbox blinks native tray images and flashes taskbar; no transient focus or OS foreground change; duplicates/reloads stay quiet; resolving/hiding stops the signal.");
  console.log(JSON.stringify({ dataPath, reveals, activations, trayFrames: images.length, flashes }));
}

let failed = false;
const watchdog = setTimeout(() => { console.error("Presentation smoke timed out"); app.exit(1); }, 90000);
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
