// Isolated Electron rendering of every status, transitions, sorting and stale evidence.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-activity-"));
const reportPath = process.env.TRAY_PLATFORM_SMOKE_REPORT || path.join(dataPath, "result.json");
app.setPath("userData", dataPath);
for (const stream of [process.stdout, process.stderr]) stream.on("error", error => { if (error.code !== "EPIPE") throw error; });
let window;
async function runLive() {
  require("./smoke-environment.cjs");
  Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "" });
  const { mainWindow, codexInstances } = await require("../dist/main/index.js").applicationReady;
  window = mainWindow; window.webContents.setAudioMuted(true);
  await codexInstances.refresh();
  await codexInstances.refreshActivity();
  const snapshot = codexInstances.list();
  assert.equal(snapshot.error, undefined);
  const read = () => window.webContents.executeJavaScript(`(${(() => [...document.querySelectorAll("#codex-instances tbody tr")].map(row => ({
    pid: Number(row.dataset.codexPid), activity: row.querySelector("[data-codex-activity]")?.dataset.codexActivity,
    label: row.querySelector("[data-codex-activity]")?.getAttribute("aria-label"),
  }))).toString()})()`);
  let rows;
  const deadline = Date.now() + 10000;
  do {
    rows = await read();
    if (rows.length === snapshot.instances.length && snapshot.instances.every(instance =>
      rows.some(row => row.pid === instance.codexPid && row.activity === instance.activity))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(rows.length, snapshot.instances.length);
  for (const instance of snapshot.instances) assert(rows.some(row => row.pid === instance.codexPid && row.activity === instance.activity));
  window.setSize(1120, 920); window.showInactive();
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Codex Instances').click();
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
  const screenshotPath = path.join(dataPath, "live-activity-icons.png");
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  codexInstances.close();
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, screenshotPath, rows }, null, 2));
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1120, height: 620, show: false,
    webPreferences: { contextIsolation: true, sandbox: true } });
  const css = fs.readFileSync(path.join(__dirname, "../dist/app/index.css"), "utf8");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><section id="fixture"></section></body></html>`));
  const bundle = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../src/app/codex-instances-ui.ts")],
    bundle: true, write: false, format: "iife", globalName: "CodexFixture", platform: "browser" }).outputFiles[0].text;
  await window.webContents.executeJavaScript(bundle);
  const result = await window.webContents.executeJavaScript(`(${(() => {
    const root = document.getElementById("fixture"); let changed;
    const rows = ["working", "waiting", "idle", "unknown"].map((activity, i) => ({ codexPid: i + 1,
      vscodePid: i + 10, vscodeMainPid: 1, title: ["Breaditor", "Dredmor", "Tray Platform", "Older session"][i],
      workspace: "D:\\dev\\" + ["breaditor-v2", "dredmor", "tray-platform", "archive"][i], activity, activityCheckedAt: Date.now() }));
    const snapshot = { supported: true, scanning: false, scannedAt: Date.now(), instances: rows };
    const dispose = CodexFixture.mountCodexInstancesUI(root, {
      getCodexInstances: async () => snapshot, refreshCodexInstances: async () => snapshot,
      onCodexInstancesChanged: callback => { changed = callback; return () => {}; },
    });
    changed(snapshot);
    const read = () => [...root.querySelectorAll("tbody tr")].map(row => {
      const icon = row.querySelector("[data-codex-activity]");
      return { pid: Number(row.dataset.codexPid), state: icon.dataset.codexActivity, label: icon.getAttribute("aria-label"),
        title: icon.title, first: row.cells[0].firstChild === icon, width: icon.getBoundingClientRect().width,
        color: getComputedStyle(icon).color, text: row.cells[0].textContent };
    });
    const initial = read(); root.querySelector('[data-sort-column="codexPid"]').click();
    root.querySelector('[data-sort-column="codexPid"]').click(); const sorted = read();
    changed({ ...snapshot, instances: rows.map(row => row.codexPid === 1 ? { ...row, activity: "idle" } : row) });
    const transition = read();
    changed({ ...snapshot, instances: rows.map(row => ({ ...row, activityCheckedAt: Date.now() - 31000 })) });
    const stale = read(); changed(snapshot);
    window.activityFixture = { dispose, root };
    return { initial, sorted, transition, stale };
  }).toString()})()`);
  assert.deepEqual(result.initial.map(row => row.state).sort(), ["idle", "unknown", "waiting", "working"]);
  assert(result.initial.every(row => row.first && row.width === 20 && row.title.startsWith(row.label + ":")));
  assert.equal(new Set(result.initial.map(row => row.color)).size, 4);
  assert.deepEqual(result.sorted.map(row => row.pid), [4, 3, 2, 1]);
  assert.equal(result.transition.find(row => row.pid === 1).state, "idle");
  assert(result.stale.every(row => row.state === "unknown"));
  window.showInactive();
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshotPath = path.join(dataPath, "activity-icons.png");
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("window.activityFixture.dispose()");
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, screenshotPath, result }, null, 2));
}
const watchdog = setTimeout(() => { fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: "Timed out" })); app.exit(1); }, 60000);
(process.argv.includes("--live") ? runLive() : run()).then(() => { clearTimeout(watchdog); app.exit(0); }).catch(error => {
  fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: error.stack })); clearTimeout(watchdog); app.exit(1);
});
