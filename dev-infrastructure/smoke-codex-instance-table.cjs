// Run with Electron. Exercises the actual table module without touching the live app.
const assert = require("assert").strict;
const fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", error => { if (error.code !== "EPIPE") throw error; });
}
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-table-"));
const reportPath = process.env.TRAY_PLATFORM_SMOKE_REPORT || path.join(dataPath, "result.json");
app.setPath("userData", dataPath);
app.setName("Tray Codex table smoke " + process.pid);
let window;
const evaluate = fn => window.webContents.executeJavaScript(`(${fn.toString()})()`);

async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1050, height: 660, show: false,
    webPreferences: { contextIsolation: true, sandbox: true } });
  const html = fs.readFileSync(path.join(__dirname, "../src/app/index.html"), "utf8")
    .replace(/<header[\s\S]*?<\/header>/, '<section id="fixture"></section>')
    .replace(/<script[\s\S]*?<\/script>/, "");
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const bundle = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../src/app/codex-instances-ui.ts")],
    bundle: true, write: false, format: "iife", globalName: "CodexFixture", platform: "browser" }).outputFiles[0].text;
  await window.webContents.executeJavaScript(bundle);
  const result = await evaluate(async () => {
    const root = document.getElementById("fixture");
    let changed, resolveInitial;
    let refreshed = 0, unsubscribed = false;
    const dispose = CodexFixture.mountCodexInstancesUI(root, {
      getCodexInstances: () => new Promise(resolve => { resolveInitial = resolve; }),
      onCodexInstancesChanged: callback => { changed = callback; return () => { unsubscribed = true; }; },
      refreshCodexInstances: async () => { refreshed++; },
    });
    const rows = [
      { codexPid: 100, vscodePid: 9, vscodeMainPid: 1, title: "Zebra", workspace: "D:\\alpha", lastFileUpdatedAt: 1000000000000 },
      { codexPid: 20, vscodePid: 100, vscodeMainPid: 1, title: "alpha", workspace: "D:\\zebra", lastFileUpdatedAt: 2000000000000 },
      { codexPid: 3, vscodePid: 20, vscodeMainPid: 1 },
    ];
    let snapshot = { supported: true, scanning: false, scannedAt: Date.now(), instances: rows };
    changed(snapshot);
    resolveInitial({ supported: true, scanning: true, instances: [] }); await Promise.resolve();
    const ids = () => [...root.querySelectorAll("tbody tr")].map(row => Number(row.dataset.codexPid));
    const ordering = [];
    for (const key of ["title", "workspace", "vscodePid", "codexPid", "lastFileUpdatedAt"]) {
      const button = root.querySelector(`[data-sort-column="${key}"]`);
      // Title is initially ascending; capture it before toggling.
      if (key !== "title") button.click();
      ordering.push({ key, direction: button.parentElement.getAttribute("aria-sort"), ids: ids() });
      button.click();
      ordering.push({ key, direction: button.parentElement.getAttribute("aria-sort"), ids: ids() });
    }
    const timestamp = root.querySelector('[data-codex-pid="20"] td:last-child').textContent;
    const unavailable = root.querySelector('[data-codex-pid="3"] td:last-child').textContent;
    snapshot = { ...snapshot, instances: [...rows, { codexPid: 7, vscodePid: 7, vscodeMainPid: 1,
      title: "New window", workspace: "D:\\new", lastFileUpdatedAt: 1500000000000 }] };
    changed({ ...snapshot, scanning: true });
    const scanningOrder = ids();
    changed({ ...snapshot, error: "Discovery unavailable" });
    const retainedOrder = ids();
    const activeSorts = [...root.querySelectorAll('th[aria-sort]')].filter(th => th.getAttribute("aria-sort") !== "none").length;
    root.querySelector("button").click(); await Promise.resolve();
    const labels = [...root.querySelectorAll("th button")].every(button => button.getAttribute("aria-label").includes("sort "));
    root.querySelector('[data-sort-column="codexPid"]').focus();
    window.tableFixture = { root, dispose, changed, snapshot, ids, unsubscribed: () => unsubscribed };
    return { ordering, timestamp, expectedTimestamp: new Date(rows[1].lastFileUpdatedAt).toLocaleString(),
      unavailable, scanningOrder, retainedOrder, activeSorts, labels, refreshed };
  });
  const ascending = { title: [20, 100, 3], workspace: [100, 20, 3], vscodePid: [100, 3, 20],
    codexPid: [3, 20, 100], lastFileUpdatedAt: [100, 20, 3] };
  const descending = { title: [100, 20, 3], workspace: [20, 100, 3], vscodePid: [20, 3, 100],
    codexPid: [100, 20, 3], lastFileUpdatedAt: [20, 100, 3] };
  for (const order of result.ordering) {
    assert.deepEqual(order.ids, (order.direction === "ascending" ? ascending : descending)[order.key], `${order.key} ${order.direction}`);
  }
  assert.equal(result.timestamp, result.expectedTimestamp);
  assert.equal(result.unavailable, "Unavailable");
  assert.deepEqual(result.scanningOrder, [20, 7, 100, 3]);
  assert.deepEqual(result.retainedOrder, [20, 7, 100, 3]);
  assert.equal(result.activeSorts, 1);
  assert(result.labels);
  assert.equal(result.refreshed, 1);
  window.showInactive();
  window.focus();
  window.webContents.focus();
  await evaluate(() => document.querySelector('[data-sort-column="codexPid"]').focus());
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate(() => window.tableFixture.ids()), [3, 7, 20, 100]);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate(() => window.tableFixture.ids()), [100, 20, 7, 3]);
  const screenshotPath = path.join(dataPath, "codex-instance-table.png");
  await evaluate(() => { const fixture = window.tableFixture; fixture.changed(fixture.snapshot); document.activeElement.blur(); });
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  const cleanup = await evaluate(() => {
    const fixture = window.tableFixture;
    fixture.changed({ ...fixture.snapshot, instances: [] });
    const empty = fixture.root.querySelector("table").hidden;
    fixture.dispose(); fixture.changed(fixture.snapshot);
    return empty && fixture.root.childElementCount === 0 && fixture.unsubscribed();
  });
  assert(cleanup);
  fs.writeFileSync(reportPath, JSON.stringify({ passed: true, dataPath, screenshotPath, result, keyboard: true, cleanup }, null, 2));
}

const watchdog = setTimeout(() => { fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: "Smoke timed out" })); app.exit(1); }, 45000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }).catch(error => {
  fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: error.stack || String(error) }));
  clearTimeout(watchdog); app.exit(1);
});
