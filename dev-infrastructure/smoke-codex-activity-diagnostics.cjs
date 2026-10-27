// Isolated desktop/phone rendering; never contacts a live Codex session.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app, BrowserWindow } = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-activity-diagnostics-"));
app.setPath("userData", path.join(directory, "profile"));
app.on("window-all-closed", () => {});
console.log("Activity diagnostics evidence:", directory);
let window;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, argument) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`);
async function wait(label, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(40); }
  throw Error("Timeout: " + label);
}
async function run() {
  await app.whenReady();
  const bundle = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../src/app/codex-instances-ui.ts")],
    bundle: true, write: false, format: "iife", globalName: "ActivityFixture", platform: "browser" }).outputFiles[0].text;
  const results = [];
  for (const phone of [false, true]) {
    window = new BrowserWindow({ width: phone ? 390 : 1120, height: 880, show: false,
      webPreferences: { contextIsolation: true, sandbox: true } });
    const errors = [];
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    const css = fs.readFileSync(path.join(__dirname, phone ? "../dist/web/index.css" : "../dist/app/index.css"), "utf8");
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><fieldset id="online-controls"><section id="fixture"></section></fieldset></body></html>`));
    await window.webContents.executeJavaScript(bundle);
    await evaluate(phone => {
      const row = { codexPid: 42, codexStartedAt: "2026-10-26T10:00:00Z", vscodePid: 2,
        vscodeStartedAt: "2026-10-26T09:00:00Z", vscodeMainPid: 3, title: "Tray Platform",
        workspace: "D:/dev/grue/tray-platform", activity: "unknown", activityReason: "owner-unavailable",
        activityCheckedAt: Date.now(), activityLastKnownAt: Date.now() - 60000 };
      const fixture = window.fixture = { snapshot: { supported: true, scanning: false, scannedAt: Date.now(), instances: [row] }, refreshes: 0 };
      fixture.dispose = ActivityFixture.mountCodexInstancesUI(document.querySelector("#fixture"), {
        getCodexInstances: async () => fixture.snapshot,
        onCodexInstancesChanged: callback => { fixture.changed = callback; return () => {}; },
        refreshCodexInstances: () => {
          fixture.refreshes++;
          return new Promise((resolve, reject) => { fixture.resolveRefresh = resolve; fixture.rejectRefresh = reject; });
        },
      }, { phone });
      fixture.changed(fixture.snapshot);
    }, phone);
    const read = () => evaluate(() => {
      const root = document.querySelector("[data-activity-details]"), icon = document.querySelector("tbody [data-codex-activity]");
      return { reason: root.querySelector("[data-activity-reason]").textContent, last: root.querySelector("[data-activity-last-known]").textContent,
        visible: root.getBoundingClientRect().height > 0, state: icon.dataset.codexActivity, tooltip: icon.title,
        accessible: icon.getAttribute("aria-description"), disabled: root.querySelector("button").matches(":disabled"),
        refreshes: window.fixture.refreshes, expanded: document.querySelector("[data-instance-disclosure]")?.getAttribute("aria-expanded") };
    });
    assert.equal((await read()).visible, !phone);
    if (phone) {
      assert(await evaluate(() => document.querySelector("tbody tr").getBoundingClientRect().height < 100), "Collapsed phone entry stays compact");
      await evaluate(() => document.querySelector("[data-instance-disclosure]").click());
    }
    let info = await read();
    assert(info.visible && info.reason.includes("owning client is unavailable") && info.last.startsWith("Last confirmed:"));
    assert(info.tooltip.includes(info.reason) && info.accessible.includes(info.reason));
    if (phone) for (const width of [320, 390]) {
      window.setSize(width, 880); await sleep(50);
      assert(await evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}px`);
      assert(await evaluate(() => document.querySelector("[data-activity-refresh]").getBoundingClientRect().height >= 44));
    }
    await evaluate(() => {
      document.querySelector("[data-activity-refresh]").focus();
      window.fixture.changed(window.fixture.snapshot);
    });
    assert(await evaluate(() => document.activeElement.matches("[data-activity-refresh]")), "Automatic snapshots preserve refresh-button focus");
    await evaluate(() => {
      document.querySelector("[data-activity-refresh]").click();
      document.querySelector("[data-activity-refresh]").click();
    });
    assert.equal((await read()).refreshes, 1); assert((await read()).disabled);
    await evaluate(() => window.fixture.rejectRefresh(Error("Fixture refresh failed")));
    await wait("failed refresh unlocks", async () => !(await read()).disabled);
    assert(await evaluate(() => document.querySelector('#fixture > [role="alert"]').textContent.includes("Fixture refresh failed")));
    await evaluate(() => {
      document.querySelector("[data-activity-refresh]").click();
      const f = window.fixture, previous = f.snapshot.instances[0];
      f.snapshot = { ...f.snapshot, instances: [{ ...previous, activity: "idle", activityReason: undefined,
        activityCheckedAt: Date.now(), activityLastKnownAt: Date.now() }] };
      f.resolveRefresh(f.snapshot);
    });
    await wait("refresh recovery", async () => (await read()).state === "idle");
    assert(!(await read()).visible, "Recovery removes the obsolete failure explanation");
    await evaluate(() => {
      const f = window.fixture;
      f.snapshot.instances[0].activityCheckedAt = Date.now() - 29950;
      f.changed(f.snapshot);
    });
    await wait("stale activity expires without a publication", async () => (await read()).state === "unknown");
    info = await read(); assert(info.visible && info.reason.includes("out of date"));
    if (phone) assert.equal(info.expanded, "true");
    await evaluate(() => {
      const f = window.fixture;
      f.snapshot.instances[0] = { ...f.snapshot.instances[0], activity: "unknown", activityReason: "unsupported-protocol", activityCheckedAt: Date.now() };
      f.changed(f.snapshot);
    });
    info = await read(); assert(info.reason.includes("unsupported activity protocol"));
    window.showInactive();
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const screenshot = path.join(directory, phone ? "phone.png" : "desktop.png");
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG()); window.hide();
    await evaluate(() => {
      document.querySelector("#online-controls").disabled = true;
      document.querySelector("[data-activity-refresh]").dispatchEvent(new Event("click"));
    });
    assert.equal((await read()).refreshes, 2, "Offline fieldset prevents even a synthetic refresh");
    assert.equal(errors.length, 0, errors.join("\n"));
    results.push({ phone, screenshot, info });
    await evaluate(() => window.fixture.dispose()); window.destroy(); window = undefined;
  }
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
  console.log("PASS activity explanations, timestamps, refresh/recovery, expiry, phone disclosure, focus and offline controls");
}
const watchdog = setTimeout(() => { console.error("Diagnostics smoke timed out"); app.exit(1); }, 45000);
run().then(() => { clearTimeout(watchdog); app.exit(0); }, error => {
  console.error(error); clearTimeout(watchdog); window?.destroy(); app.exit(1);
});
