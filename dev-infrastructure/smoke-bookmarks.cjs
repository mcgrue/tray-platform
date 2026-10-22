// Run after yarn pre-build: electron dev-infrastructure/smoke-bookmarks.cjs
// Isolated user data, intercepted links, retained evidence, and no file deletion.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { spawn } = require("child_process");
const { app, shell, globalShortcut } = require("electron");
require("./smoke-environment.cjs");
const restartIndex = process.argv.indexOf("--verify-restart");
const restarting = restartIndex >= 0;
const dataPath = restarting ? process.argv[restartIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "tray-platform-bookmarks-smoke-"));
// Parent and restart verifier share the store, so avoid sharing Chromium's locked shader cache.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.setName(`Tray Platform bookmarks smoke ${process.pid}`);
app.setPath("userData", dataPath);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const opened = [], callbacks = new Map();
shell.openExternal = async url => { opened.push(url); };
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (accelerator, callback) => {
  const registered = register(accelerator, callback);
  if (registered) callbacks.set(accelerator, callback);
  return registered;
};
console.log(`Bookmark smoke user data retained at: ${dataPath}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const runtime = await require(path.join(__dirname, "../dist/main/index.js")).applicationReady;
  assert(runtime, "Isolated application acquired instance lock");
  const { mainWindow, bookmarks, attention, shortcuts, desktop, server, navigatePending, captureBookmarks } = runtime;
  assert(bookmarks && captureBookmarks, "Bookmark runtime integration exists");
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await waitFor("bookmark panel", () => evaluate(() => Boolean(document.querySelector("[data-bookmark-panel]"))));
  if (restarting) {
    assert.equal(bookmarks.list().bookmarks.length, 4);
    assert.equal(bookmarks.get("robot", "task").humanNote, "Human: inspect inventory next");
    assert.equal(bookmarks.get("robot", "task").robotHint, "Robot: all tests passed");
    assert.equal(attention.get("smoke", "task").state, "done");
    await waitFor("restarted bookmark UI", () => evaluate(() => document.querySelector("[data-bookmark-panel]").textContent.includes("Human: inspect inventory next")));
    console.log("PASS: fresh Electron process restored bookmarks, notes, hints, and completed task history");
    return;
  }
  if (!server.listening) await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const port = server.address().port;
  const request = (method, pathname, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode, value: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Bookmark HTTP request timed out")));
    req.on("error", reject); req.end(payload);
  });
  const click = (title, action) => evaluate((expected, label) => {
    const panel = document.querySelector("[data-bookmark-panel]");
    const card = expected ? Array.from(panel.querySelectorAll("article")).find(node => node.querySelector("h3")?.textContent === expected) : panel;
    const button = card && Array.from(card.querySelectorAll("button")).find(node => node.textContent === label && !node.disabled);
    if (!button) throw new Error(`Missing ${label} for ${expected || "bookmark panel"}`);
    button.click();
  }, title, action);
  const edit = async fields => {
    await waitFor("bookmark editor", () => evaluate(() => Boolean(document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])'))));
    await evaluate(values => {
      const form = document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])');
      for (const [name, value] of Object.entries(values)) {
        const label = Array.from(form.querySelectorAll("label")).find(node => node.textContent.trim().startsWith(name));
        const input = label?.querySelector("input,textarea,select");
        if (!input) throw new Error(`Missing bookmark field ${name}`);
        input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, fields);
    await waitFor("bookmark saved", () => evaluate(() => !document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])')));
  };
  const link = { kind: "url", url: "https://example.com/bookmark-resume" };
  await attention.upsert("smoke", "task", { title: "Bookmark task", project: "Tray Platform", destination: link });
  const created = await request("PUT", "/api/bookmarks/robot/task", { title: "Task bookmark", attention: { source: "smoke", id: "task" }, project: "Tray Platform", destination: link, robotHint: "Robot: waiting for review" });
  assert.equal(created.status, 200);
  await waitFor("robot bookmark rendered", () => evaluate(() => document.querySelector("[data-bookmark-panel]").textContent.includes("Robot: waiting for review")));
  const originalSaveHuman = bookmarks.saveHuman.bind(bookmarks);
  let releaseSave, saveStarted = false;
  bookmarks.saveHuman = async (...args) => {
    saveStarted = true;
    await new Promise(resolve => { releaseSave = resolve; });
    return originalSaveHuman(...args);
  };
  await click("Task bookmark", "Edit");
  const saving = edit({ "Human note": "Human: inspect inventory next" });
  await waitFor("human save reached main process", () => saveStarted);
  assert.equal(await evaluate(() => Array.from(document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])').querySelectorAll("input,textarea,select,button")).every(control => control.disabled)), true);
  releaseSave(); await saving; bookmarks.saveHuman = originalSaveHuman;
  assert.equal(bookmarks.get("robot", "task").humanNote, "Human: inspect inventory next");
  const updated = await request("PUT", "/api/bookmarks/robot/task", { robotHint: "Robot: all tests passed" });
  assert.equal(updated.status, 200); assert.equal(updated.value.bookmark.humanNote, "Human: inspect inventory next");
  assert.deepEqual(updated.value.bookmark.destination, link);
  assert.deepEqual(updated.value.bookmark.attention, { source: "smoke", id: "task" });
  assert.equal((await request("PUT", "/api/bookmarks/robot/task", { humanNote: "Unauthorized overwrite" })).status, 400);
  assert.equal((await request("GET", "/api/bookmarks")).value.bookmarks.length, 1);
  await click("Task bookmark", "Go"); await waitFor("intercepted bookmark link", () => opened.length === 1);
  assert.equal(opened[0], link.url);
  assert.equal(attention.get("smoke", "task").state, "pending");

  await click(undefined, "New bookmark");
  await edit({ Title: "Project-only bookmark", Project: "Another project", "Human note": "Project next action" });
  const project = bookmarks.list().bookmarks.find(item => item.title === "Project-only bookmark");
  assert(project && !project.attention && !project.destination);
  await evaluate(() => {
    const filter = document.querySelector('[data-bookmark-panel] input[type="search"]'); filter.value = "Another"; filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await evaluate(() => document.querySelectorAll("[data-bookmark-list] article").length), 1);
  await evaluate(() => {
    const filter = document.querySelector('[data-bookmark-panel] input[type="search"]'); filter.value = ""; filter.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await attention.upsert("smoke", "second", { title: "Other pending task" });
  mainWindow.show(); mainWindow.minimize();
  await waitFor("application window minimizes normally", () => mainWindow.isMinimized());
  assert.equal(mainWindow.isVisible(), true, "Minimization retains the taskbar window");
  await navigatePending();
  await waitFor("pending chooser restores minimized application", async () => mainWindow.isVisible() && !mainWindow.isMinimized() && await evaluate(() => !document.querySelector("[data-navigation-chooser]").hidden));
  await evaluate(() => {
    const input = document.querySelector('[data-navigation-chooser] input'); input.value = "Bookmark task"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor("chooser resume text", () => evaluate(() => document.querySelector("[data-navigation-chooser]").textContent.includes("Human: inspect inventory next")));
  await evaluate(() => Array.from(document.querySelectorAll('[data-navigation-chooser] button')).find(button => button.textContent === "Close chooser").click());
  await attention.setState("smoke", "task", "done");
  assert.equal(bookmarks.get("robot", "task").humanNote, "Human: inspect inventory next");

  const setting = shortcuts.list().settings.find(entry => entry.key === "capture");
  assert(setting && setting.registered, setting?.error || "Capture shortcut missing");
  assert(globalShortcut.isRegistered(setting.accelerator));
  const captureCallback = callbacks.get(setting.accelerator); assert(captureCallback);
  const originalCapture = desktop.captureForeground.bind(desktop);
  let nativeCaptureCount = 0;
  mainWindow.hide();
  desktop.captureForeground = async () => {
    assert.equal(mainWindow.isVisible(), false, "Window remains hidden before native capture");
    const result = await originalCapture();
    assert.equal(mainWindow.isVisible(), false, "Window remains hidden until native capture completes");
    nativeCaptureCount++; return result;
  };
  captureCallback(); captureCallback();
  await waitFor("native capture then editor", () => nativeCaptureCount === 1 && mainWindow.isVisible());
  await waitFor("native capture editor mounted", () => evaluate(() => Boolean(document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])'))));
  await evaluate(() => {
    const form = document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])');
    const note = form.querySelector("textarea"); note.value = "Draft retained across repeated actions"; note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(undefined, "New bookmark"); await click("Task bookmark", "Edit");
  desktop.captureForeground = async () => undefined;
  await captureBookmarks();
  assert.equal(await evaluate(() => document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden]) textarea').value), "Draft retained across repeated actions");
  await edit({ Title: "Captured context", Project: "Tray Platform", "Human note": "Native capture before UI" });
  assert(bookmarks.list().bookmarks.some(item => item.title === "Captured context"));

  desktop.captureForeground = async () => { throw new Error("Intentional smoke capture failure"); };
  await captureBookmarks();
  await waitFor("capture failure shown", () => evaluate(() => document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])')?.textContent.includes("Intentional smoke capture failure")));
  await click(undefined, "Cancel");
  await captureBookmarks();
  await waitFor("Cancel permits next capture", () => evaluate(() => Boolean(document.querySelector('[data-bookmark-panel] [data-bookmark-editor]:not([hidden])'))));
  await edit({ Title: "Capture failure note", Project: "Tray Platform", "Human note": "Saving still works" });
  const failedCapture = bookmarks.list().bookmarks.find(item => item.title === "Capture failure note");
  assert(failedCapture && !failedCapture.destination);
  desktop.captureForeground = originalCapture;

  const replacement = "Ctrl+Alt+Shift+F9";
  await evaluate(accelerator => {
    const form = Array.from(document.querySelectorAll("[data-navigation-panel] form")).find(node => node.textContent.includes("Capture bookmark shortcut"));
    if (!form) throw new Error("Capture shortcut settings row missing");
    form.querySelector("input").value = accelerator;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, replacement);
  await waitFor("capture shortcut settings saved", () => shortcuts.list().settings.some(entry => entry.key === "capture" && entry.accelerator === replacement && entry.registered));
  assert.equal(bookmarks.list().bookmarks.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataPath, "bookmarks.json"), "utf8")).bookmarks.length, 4);

  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("bookmarks restored after renderer reload", () => evaluate(() => document.querySelectorAll("[data-bookmark-panel]").length === 1 && document.querySelector("[data-bookmark-panel]").textContent.includes("Human: inspect inventory next")));
  assert.equal(await evaluate(() => document.querySelectorAll("[data-bookmark-list] article").length), 4);
  await evaluate(() => Array.from(document.querySelectorAll("[data-bookmark-list] article")).find(card => card.querySelector("h3")?.textContent === "Task bookmark").scrollIntoView({ block: "center" }));
  const screenshotPath = path.join(dataPath, "bookmarks-acceptance.png");
  fs.writeFileSync(screenshotPath, (await mainWindow.webContents.capturePage()).toPNG());
  console.log(`Bookmark screenshot: ${screenshotPath}`);

  // Release only this isolated test instance so a fresh process can load the exact retained store.
  app.releaseSingleInstanceLock();
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [__filename, "--verify-restart", dataPath], { windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const childCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Restart verification timed out")); }, 40000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); resolve(code); });
  });
  console.log(output.trim()); assert.equal(childCode, 0, "Restart verifier succeeded");
  console.log("PASS: robot HTTP, human form edits, ownership, task/project associations, Go, completed history, native capture ordering/concurrency, capture failure saving, capture shortcut settings, chooser resume note, renderer reload, fresh process persistence, screenshot");
}
let failed = false;
app.on("will-quit", () => app.exit(failed ? 1 : 0));
const watchdog = setTimeout(() => { console.error("Bookmark smoke exceeded 150 seconds"); app.exit(1); }, 150000);
run().catch(error => { failed = true; console.error(error); }).finally(() => { clearTimeout(watchdog); process.exitCode = failed ? 1 : 0; app.quit(); });
