// Run after yarn pre-build: electron dev-infrastructure/smoke-navigation-progress.cjs
// Exercises real renderer/IPC progress with controlled scan/activation delays.
// Uses retained isolated data and never focuses another application.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app } = require("electron");
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-navigation-progress-"));
const reportPath = process.env.TRAY_PLATFORM_SMOKE_REPORT || path.join(dataPath, "result.json");
app.setName("Tray navigation progress smoke " + process.pid);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40); }
  throw new Error("Timeout: " + label);
}
let application, failed = false;
async function run() {
  application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow, desktop, codexInstances, attention } = application;
  mainWindow.webContents.setAudioMuted(true);
  mainWindow.hide();
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const capture = async name => {
    mainWindow.showInactive();
    await sleep(200);
    const screenshot = await mainWindow.webContents.capturePage();
    assert(!screenshot.isEmpty(), "Smoke screenshot must contain rendered pixels");
    fs.writeFileSync(path.join(dataPath, name), screenshot.toPNG());
    mainWindow.hide();
  };
  await waitFor("initial scan", () => !codexInstances.list().scanning);
  codexInstances.close();
  const startedAt = "2026-10-20T10:00:00Z";
  const origin = { kind: "vscode-codex", codexPid: 3, codexStartedAt: startedAt, vscodePid: 2, vscodeStartedAt: startedAt };
  const destination = { kind: "window", hwnd: "123", pid: 1, processStartedAt: startedAt, title: "dredmor" };
  const snapshot = { supported: true, scanning: false, instances: [{ ...origin, vscodeMainPid: 1, title: "dredmor" }] };
  let finishScan, finishActivation, failActivation, finishCheck, scanCount = 0, activationCount = 0, processesRunning = false;
  codexInstances.list = () => snapshot;
  codexInstances.refresh = () => { scanCount++; return new Promise(resolve => { finishScan = resolve; }); };
  desktop.areProcessesRunning = () => processesRunning ? new Promise(resolve => { finishCheck = resolve; }) : Promise.resolve(false);
  desktop.listWindows = async () => [destination];
  desktop.activate = (target, guard) => {
    activationCount++;
    assert.deepEqual(target, destination);
    assert.equal(guard.title, "dredmor");
    return new Promise((resolve, reject) => { finishActivation = resolve; failActivation = reject; });
  };
  await attention.upsert("codex", "progress-smoke", { title: "Dredmor navigation progress smoke", origin });
  mainWindow.hide();
  await waitFor("card", () => evaluate(() => !!document.querySelector("main article")));
  const readCard = () => evaluate(() => {
    const card = document.querySelector("main article");
    return { status: card.querySelector(':scope > [role="status"]').textContent,
      error: card.querySelector(':scope > [role="alert"]').textContent,
      button: card.querySelector("[data-card-actions] button").textContent, disabled: card.querySelector("[data-card-actions] button").disabled };
  });
  const clickGo = () => evaluate(() => document.querySelector("main article [data-card-actions] button").click());
  await clickGo();
  await waitFor("rescan status", async () => (await readCard()).button === "Rescanning…" && scanCount === 1);
  assert.equal((await readCard()).disabled, true);
  await sleep(250);
  assert.match((await readCard()).status, /Rescanning VS Code windows/);
  assert.equal(activationCount, 0);
  // Progress from a different question cannot overwrite this card.
  mainWindow.webContents.send("attention-navigation-progress", { source: "codex", id: "other", phase: "opened", destination: "wrong window" });
  await sleep(100);
  assert.match((await readCard()).status, /Rescanning/);
  await capture("rescanning.png");
  finishScan(snapshot);
  await waitFor("activation status", async () => (await readCard()).status === "Opening dredmor…" && activationCount === 1);
  assert.equal((await readCard()).disabled, true);
  finishActivation();
  await waitFor("confirmed success", async () => (await readCard()).status === "Opened dredmor." && !(await readCard()).disabled);
  assert.equal(attention.get("codex", "progress-smoke").state, "pending");
  await capture("opened.png");
  processesRunning = true;
  await clickGo();
  await waitFor("cached process check", async () => finishCheck && (await readCard()).button === "Opening…");
  assert.equal(scanCount, 1, "Checking a cached process must not claim or start a rescan");
  assert.doesNotMatch((await readCard()).status, /Rescanning/);
  finishCheck(true);
  await waitFor("second activation", () => activationCount === 2);
  assert.equal(scanCount, 1, "Live cached processes must not cause another scan");
  assert.equal((await readCard()).button, "Opening…");
  failActivation(new Error("Windows refused to activate this window."));
  await waitFor("visible native failure", async () => (await readCard()).error.includes("Windows refused") && !(await readCard()).disabled);
  assert.equal((await readCard()).status, "");
  await capture("failure-visible.png");
  // The pending-work chooser uses the same scan and reports failures in place.
  processesRunning = false;
  mainWindow.webContents.send("navigation-show", {});
  const readChooser = () => evaluate(() => {
    const panel = document.querySelector('[data-navigation-chooser]');
    return { hidden: panel.hidden, status: panel.querySelector('[role="status"]').textContent,
      error: panel.querySelector('[role="alert"]').textContent,
      button: [...panel.querySelectorAll("button")].find(button => ["Go", "Rescanning…", "Opening…"].includes(button.textContent))?.textContent };
  });
  await waitFor("chooser", async () => !(await readChooser()).hidden);
  await evaluate(() => [...document.querySelector('[data-navigation-chooser]').querySelectorAll("button")].find(button => button.textContent === "Go").click());
  await waitFor("chooser rescan", async () => (await readChooser()).button === "Rescanning…" && scanCount === 2);
  finishScan({ ...snapshot, error: "Scan failed" });
  await waitFor("chooser failure", async () => (await readChooser()).error.includes("Cannot refresh") && (await readChooser()).button === "Go");
  assert.equal((await readChooser()).status, "");
  assert.equal(activationCount, 2, "Failed scan must not activate a stale window");
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, checks: ["stale mapped process rescan feedback", "cached Go without rescan", "delayed activation feedback", "native-confirmed success", "other-item isolation", "native failure visible", "pending state retained", "chooser scan failure"] }, null, 2));
  console.log("Navigation progress smoke passed:", reportPath);
}
const watchdog = setTimeout(() => { console.error("Smoke timed out"); app.exit(1); }, 90000);
run().catch(error => {
  failed = true;
  console.error(error);
  fs.writeFileSync(reportPath, JSON.stringify({ passed: false, dataPath, error: error.stack || String(error) }, null, 2));
}).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
