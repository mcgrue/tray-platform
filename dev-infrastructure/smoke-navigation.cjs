// Run after yarn pre-build: electron dev-infrastructure/smoke-navigation.cjs
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app, shell, globalShortcut } = require("electron");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-platform-navigation-smoke-"));
app.setName(`Tray Platform navigation smoke ${process.pid}`);
app.setPath("userData", dataPath);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const opened = [], callbacks = new Map();
shell.openExternal = async url => { opened.push(url); };
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (accelerator, callback) => {
  const result = register(accelerator, callback);
  if (result) callbacks.set(accelerator, callback);
  return result;
};
console.log(`Smoke user data retained at: ${dataPath}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const runtime = await require(path.join(__dirname, "../dist/main/index.js")).applicationReady;
  assert(runtime);
  const { mainWindow, attention, shortcuts, navigatePending } = runtime;
  mainWindow.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.error(`Renderer: ${message}`); });
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const shown = () => evaluate(() => !document.querySelector("[data-navigation-chooser]").hidden);
  const key = name => evaluate(value => document.querySelector('[data-navigation-chooser] input').dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })), name);
  await waitFor("navigation panel", () => evaluate(() => Boolean(document.querySelector("[data-navigation-panel] input"))));
  const setting = shortcuts.list().settings.find(entry => entry.key === "navigate");
  assert(setting.registered, setting.error);
  assert(globalShortcut.isRegistered(setting.accelerator));
  const callback = callbacks.get(setting.accelerator);
  assert(callback, "Actual registered callback was captured");
  callback();
  await waitFor("zero-item shortcut chooser", shown);
  assert.equal(await evaluate(() => document.querySelector("[data-navigation-chooser]").textContent.includes("No pending items")), true);
  await key("Escape");
  await waitFor("Escape closes chooser", async () => !(await shown()));

  await attention.upsert("smoke", "one", { title: "First task", description: "First resume note", destination: { kind: "url", url: "https://example.com/first" } });
  callback();
  await waitFor("single target opened", () => opened.length === 1);
  assert.equal(opened[0], "https://example.com/first");
  assert.equal(attention.get("smoke", "one").state, "pending");
  await attention.upsert("smoke", "two", { title: "Second task", description: "Second resume note", destination: { kind: "url", url: "https://example.com/second" } });
  await navigatePending();
  await waitFor("multiple-item chooser", async () => await shown() && await evaluate(() => document.querySelectorAll('[data-navigation-chooser] [role="option"]').length === 2)).catch(async error => {
    console.error("Chooser diagnostic", await evaluate(() => document.querySelector('[data-navigation-chooser]').outerHTML)); throw error;
  });
  await evaluate(() => {
    const input = document.querySelector('[data-navigation-chooser] input'); input.value = "first"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await evaluate(() => document.querySelectorAll('[data-navigation-chooser] [role="option"]').length), 1);
  await attention.upsert("smoke", "three", { title: "Third task" });
  await waitFor("new snapshot received without filter loss", () => evaluate(() => document.querySelector('[data-navigation-chooser] input').value === "first" && document.querySelectorAll('[data-navigation-chooser] [role="option"]').length === 1));
  await key("Enter");
  await waitFor("Enter opens selected target", () => opened.length === 2);
  await waitFor("successful Go closes chooser", async () => !(await shown()));
  assert.equal(opened[1], "https://example.com/first");

  await navigatePending();
  await waitFor("reopened chooser", shown);
  await key("ArrowDown");
  assert.equal(await evaluate(() => document.querySelectorAll('[data-navigation-chooser] [aria-selected="true"]').length), 1);
  await evaluate(() => {
    const input = document.querySelector('[data-navigation-chooser] input'); input.value = "third"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await evaluate(() => document.querySelector("[data-navigation-chooser]").textContent.includes("Choose a destination in the attention inbox")), true);
  await attention.setState("smoke", "three", "done");
  await waitFor("disappearing item clears selection", () => evaluate(() => document.querySelectorAll('[data-navigation-chooser] [role="option"]').length === 0));

  await attention.upsert("smoke", "stale", { title: "Stale task", destination: { kind: "window", hwnd: "2147483647", pid: 2147483647, processStartedAt: "2000-01-01T00:00:00.000Z" } });
  await evaluate(() => {
    const input = document.querySelector('[data-navigation-chooser] input'); input.value = "stale"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor("stale task selectable", () => evaluate(() => document.querySelectorAll('[data-navigation-chooser] [role="option"]').length === 1));
  await key("Enter");
  await waitFor("activation error visible", () => evaluate(() => Boolean(document.querySelector('[data-navigation-chooser] [role="alert"]').textContent)));
  assert.equal(await shown(), true);

  // Reserve a real OS shortcut in a separate Electron process to exercise actual conflict reporting.
  // A temporary helper is retained with the isolated data, along with its log.
  const conflict = "Control+Alt+Shift+F11";
  const helper = path.join(dataPath, "reserved-shortcut.cjs");
  fs.writeFileSync(helper, `const {app,globalShortcut}=require('electron'); app.setName('Tray smoke reservation ${process.pid}'); app.whenReady().then(()=>{console.log(globalShortcut.register(${JSON.stringify(conflict)},()=>{})?'READY':'FAILED')});`);
  const { spawn } = require("child_process");
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [helper], { windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let childOutput = "";
  child.stdout.on("data", chunk => { childOutput += chunk; });
  child.stderr.on("data", chunk => { childOutput += chunk; });
  try {
    await waitFor("external shortcut reserved", () => childOutput.includes("READY"));
    await evaluate(async accelerator => { await window.ipcComms.setShortcut("navigate", accelerator); }, conflict);
    await waitFor("conflict shown", () => evaluate(() => document.querySelector('[data-navigation-panel]').textContent.includes("tray menu")));
    assert.equal(shortcuts.list().settings.find(entry => entry.key === "navigate").registered, false);
    await evaluate(async () => { await window.ipcComms.setShortcut("navigate", "Ctrl+Alt+Space"); });
    await waitFor("shortcut restored", () => shortcuts.list().settings.find(entry => entry.key === "navigate").registered);
  } finally { child.kill(); }

  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("reload navigation panel", () => evaluate(() => document.querySelectorAll("[data-navigation-panel]").length === 1 && Boolean(document.querySelector("[data-navigation-panel] input"))));
  await navigatePending(); await navigatePending();
  await waitFor("chooser after repeated invocations", shown);
  assert.equal(await evaluate(() => document.querySelectorAll("[data-navigation-chooser]").length), 1);
  await key("Escape");
  console.log("PASS: real shortcut registration/callback, zero/single/multiple targets, filtering/selection, Enter/Escape, disappeared items, activation failure, OS conflict, reload/repeated invocation");
}
let failed = false;
const watchdog = setTimeout(() => { console.error("Navigation smoke exceeded 100 seconds"); app.exit(1); }, 100000);
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
