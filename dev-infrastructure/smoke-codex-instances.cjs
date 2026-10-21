// Run with Electron after yarn pre-build. Uses isolated data and real Windows discovery.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app } = require("electron");
// A GUI launch can outlive its shell's pipes. Do not turn a closed log stream
// into an Electron error dialog; the durable report below is the source of truth.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", error => { if (error.code !== "EPIPE") throw error; });
}
require("./smoke-environment.cjs");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-instances-"));
const reportPath = process.env.TRAY_PLATFORM_SMOKE_REPORT || path.join(dataPath, "result.json");
app.setName("Tray Codex instances smoke " + process.pid);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: dataPath, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error("Timeout: " + label);
}
function getJson(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/codex-instances" }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", data => { body += data; });
      res.on("end", () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on("error", reject);
  });
}
async function run() {
  const { mainWindow, codexInstances, server } = await require("../dist/main/index.js").applicationReady;
  mainWindow.webContents.setAudioMuted(true);
  const evaluate = fn => mainWindow.webContents.executeJavaScript(`(${fn.toString()})()`);
  const read = () => evaluate(() => {
    const root = document.getElementById("codex-instances");
    return { heading: root.querySelector("h2").textContent, status: root.querySelector('[role="status"]').textContent,
      error: root.querySelector('[role="alert"]').textContent, disabled: root.querySelector("button").disabled,
      rows: [...root.querySelectorAll("tbody tr")].map(row => [...row.cells].map(cell => cell.textContent)),
      afterInbox: root.previousElementSibling.tagName === "MAIN", audioCount: document.querySelectorAll("audio").length };
  });
  await waitFor("initial process scan", () => !codexInstances.list().scanning && Boolean(codexInstances.list().scannedAt));
  let snapshot = codexInstances.list();
  assert.equal(snapshot.error, undefined);
  await waitFor("rendered process rows", async () => (await read()).rows.length === snapshot.instances.length);
  let ui = await read();
  assert(ui.afterInbox); assert(ui.audioCount > 0); assert(!ui.disabled);
  for (const instance of snapshot.instances) {
    assert(ui.rows.some(row => row[2] === String(instance.vscodePid) && row[3] === String(instance.codexPid)));
  }
  assert.deepEqual((await getJson(server.address().port)).instances, snapshot.instances);
  const firstScan = snapshot.scannedAt;
  await evaluate(() => document.querySelector("#codex-instances button").click());
  await waitFor("manual refresh started", async () => (await read()).disabled);
  await waitFor("manual refresh finished", () => !codexInstances.list().scanning && codexInstances.list().scannedAt > firstScan);
  snapshot = codexInstances.list();
  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("reload restores inventory", async () => (await read()).rows.length === snapshot.instances.length && !(await read()).disabled);

  // Exercise rendering states with the actual UI module in an isolated fixture root.
  const bundle = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../src/app/codex-instances-ui.ts")],
    bundle: true, write: false, format: "iife", globalName: "CodexFixture", platform: "browser" }).outputFiles[0].text;
  await mainWindow.webContents.executeJavaScript(bundle);
  const fixtureResult = await evaluate(async () => {
    const root = document.createElement("section"); document.body.appendChild(root);
    let changed, resolveInitial;
    let refreshed = 0, unsubscribed = false;
    const dispose = CodexFixture.mountCodexInstancesUI(root, {
      getCodexInstances: () => new Promise(resolve => { resolveInitial = resolve; }),
      onCodexInstancesChanged: callback => { changed = callback; return () => { unsubscribed = true; }; },
      refreshCodexInstances: async () => { refreshed++; },
    });
    const instance = { codexPid: 8, vscodePid: 7, vscodeMainPid: 6, title: '<img src=x onerror="alert(1)">', workspace: "D:\\a & b" };
    const snapshot = { supported: true, scanning: false, scannedAt: Date.now(), instances: [instance] };
    changed(snapshot);
    resolveInitial({ supported: true, scanning: true, instances: [] }); await Promise.resolve();
    const keptNewer = root.querySelectorAll("tbody tr").length === 1;
    const escaped = root.querySelector("td").textContent === instance.title && !root.querySelector("img");
    changed({ ...snapshot, scanning: true }); const disabledWhileScanning = root.querySelector("button").disabled;
    changed({ ...snapshot, error: "Discovery unavailable" });
    const staleLabeled = root.querySelector('[role="alert"]').textContent.includes("last successful scan");
    changed({ ...snapshot, instances: [] }); const removed = root.querySelectorAll("tbody tr").length === 0;
    changed({ ...snapshot, instances: [{ ...instance, title: undefined, workspace: undefined }] });
    const unknowns = root.textContent.includes("Window title unavailable") && root.textContent.includes("Folder unavailable");
    root.querySelector("button").click(); await Promise.resolve();
    dispose(); changed(snapshot);
    const disposed = root.childElementCount === 0 && unsubscribed;
    root.remove();
    return { keptNewer, escaped, disabledWhileScanning, staleLabeled, removed, unknowns, disposed, refreshed };
  });
  for (const [key, value] of Object.entries(fixtureResult)) assert(value === true || (key === "refreshed" && value === 1), key);
  mainWindow.setSize(1100, 1000);
  mainWindow.showInactive();
  await evaluate(() => document.getElementById("codex-instances").scrollIntoView({ block: "start" }));
  await sleep(300);
  fs.writeFileSync(path.join(dataPath, "codex-instances.png"), (await mainWindow.webContents.capturePage()).toPNG());
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, count: snapshot.instances.length,
    titled: snapshot.instances.filter(item => item.title).length, folders: snapshot.instances.filter(item => item.workspace).length,
    instances: snapshot.instances, fixtureResult }, null, 2));
}
let failed = false;
const watchdog = setTimeout(() => { fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: "Smoke timed out" })); app.exit(1); }, 120000);
run().catch(error => { failed = true; fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: error.stack || String(error) })); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
