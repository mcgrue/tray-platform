// Isolated Electron/preload/composer smoke. No requests reach live Codex sessions.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app } = require("electron");
require("./smoke-environment.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-turn-controls-smoke-"));
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: directory, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
app.setName(`Tray turn controls ${process.pid}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw Error("Timeout: " + label); }
let application;
async function run() {
  application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow: window, codexInstances, codexInstanceMessages } = application;
  window.webContents.setAudioMuted(true);
  await codexInstances.refresh(); await codexInstances.refreshActivity();
  codexInstances.options.activity?.close(); codexInstances.options.activity = undefined;
  const instance = { codexPid: 42, codexStartedAt: new Date(1000).toISOString(), vscodePid: 12,
    vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 1, title: "Fixture project", workspace: "D:/dev/grue/tray-platform" };
  codexInstances.options.scan = async () => ({ instances: [instance] });
  const sent = [];
  let current = { model: "gpt-6-sol", effort: "medium" }, fail = false;
  const catalog = () => ({ available: true, current, models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", defaultEffort: "medium",
    efforts: [{ id: "medium", description: "Balanced" }, { id: "high", description: "Deeper" }] }] });
  Object.assign(codexInstanceMessages.options, { verifyProcesses: async () => true,
    projects: { conversations: async () => [], owns: () => true, turnSettings: async () => catalog(),
      send: async (_instance, conversationId, message, options) => {
        if (fail) throw Error("Codex is working. Wait for this turn to finish; your draft is preserved.");
        sent.push({ conversationId, message, options });
        current = { model: options?.model || current.model, effort: options?.effort || current.effort, mode: options?.mode || current.mode };
        return { sessionId: conversationId || "created", turnId: `turn-${sent.length}`, delivery: "started" };
      } },
  });
  await codexInstances.refresh();
  console.log("Fixture instance count:", codexInstances.list().instances.length);
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await wait("instance row", () => evaluate(() => !!document.querySelector('[data-codex-pid="42"]')));
  await evaluate(() => document.querySelector('[role="tab"][aria-controls="codex-instances"]').click());
  await evaluate(() => { document.querySelector('[data-instance-menu-toggle]').click();
    document.querySelector('[data-instance-menu] [data-message-codex]').click(); });
  await wait("turn settings", () => evaluate(() => !document.querySelector('[data-codex-turn-controls] select').disabled));
  await evaluate(() => {
    const controls = document.querySelector('[data-codex-turn-controls]');
    const selects = controls.querySelectorAll('select');
    selects[0].value = "plan"; selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    selects[2].value = "high"; selects[2].dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector('[data-codex-instance-composer] textarea');
    input.value = "Plan this fixture"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('[data-codex-instance-composer] [type="submit"]').click();
  });
  await wait("selected turn sent", () => sent.length === 1);
  assert.deepEqual(sent[0], { conversationId: "", message: "Plan this fixture", options: { mode: "plan", effort: "high" } });
  await wait("effective settings", () => evaluate(() => document.querySelector('[data-codex-turn-controls] p').textContent.includes('plan · gpt-6-sol · high')));
  fail = true;
  await evaluate(() => { const input = document.querySelector('[data-codex-instance-composer] textarea');
    input.value = "Keep this draft"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const select = document.querySelector('[data-codex-turn-controls] select'); select.value = "default";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('[data-codex-instance-composer] [type="submit"]').click(); });
  await wait("active turn feedback", () => evaluate(() => document.querySelector('[data-codex-instance-composer] [role="alert"]').textContent.includes('Wait for this turn')));
  assert(await evaluate(() => document.querySelector('[data-codex-instance-composer] textarea').value === 'Keep this draft' &&
    document.querySelector('[data-codex-turn-controls] select').value === 'default'));
  window.showInactive(); await sleep(300);
  assert(await evaluate(() => document.querySelector('[data-codex-instance-composer] textarea').value === 'Keep this draft' &&
    document.querySelector('[data-codex-turn-controls] select').value === 'default'), 'Draft and selected mode survive a delayed refresh');
  await evaluate(() => document.querySelector('[data-codex-turn-controls]').scrollIntoView({ block: 'center' }));
  fs.writeFileSync(path.join(directory, "turn-controls.png"), (await window.webContents.capturePage()).toPNG());
  console.log("PASS Codex turn controls desktop smoke:", directory);
}
const watchdog = setTimeout(() => { console.error("Turn controls smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); if (application) { app.once("will-quit", () => app.exit(code)); app.quit(); } else app.exit(code); }
