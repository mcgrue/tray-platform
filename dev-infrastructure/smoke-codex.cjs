// CODEX_CLI=/path/to/extension/codex.exe electron dev-infrastructure/smoke-codex.cjs
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");
const { runQuestion } = require("./codex-question-fixture.cjs");
const { toAttention, deliver } = require("../integrations/codex/attention-hook.cjs");

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-codex-electron-"));
app.setName("Tray Codex smoke " + process.pid);
app.setPath("userData", dataPath);
process.env.TRAY_PLATFORM_USER_DATA = dataPath;
process.env.TRAY_PLATFORM_PORT = "0";
process.env.WATCH_MODE = "";
process.env.BREADITOR_DEV_MODE = "";
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Timed out: " + label);
};
async function run() {
  const application = await require("../dist/main/index.js").applicationReady;
  assert(application);
  const { mainWindow, attention, server } = application;
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  await waitFor(() => evaluate(() => !!document.querySelector("main h2")), "renderer");
  const sounds = [];
  const originalSend = mainWindow.webContents.send.bind(mainWindow.webContents);
  mainWindow.webContents.send = (channel, ...args) => {
    if (channel === "play-sound") sounds.push(args[0]);
    originalSend(channel, ...args);
  };
  // Count sound requests without making the isolated automated smoke audible.
  await evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  const results = await Promise.all([false, true].map(asynchronous => runQuestion({
    cli: process.env.CODEX_CLI, endpoint, asynchronous,
    title: asynchronous ? "Async bridge test?" : "Blocking bridge test?",
    onQuestion: async event => {
      const expected = toAttention(event);
      await waitFor(() => attention.get(expected.source, expected.id), "hook delivery");
      await waitFor(() => evaluate(title => Array.from(document.querySelectorAll("main article h3")).some(node => node.textContent === title),
        expected.body.title), "question rendered");
      assert.equal(attention.get(expected.source, expected.id).state, "pending");
      assert.equal(mainWindow.isVisible(), false, "Notifications must not steal focus");
    },
  })));
  assert.equal(attention.list().items.length, 2, "Two independent runtime sessions create distinct entries");
  assert.deepEqual(sounds, ["icq", "icq"], "One sound per question");
  await Promise.all(results.flatMap(result => Array.from({ length: 3 }, () => deliver(toAttention(result.event), { endpoint }))));
  assert.equal(attention.list().items.length, 2);
  assert.equal(sounds.length, 2, "Retries never replay the sound");
  const item = toAttention(results[0].event);
  await evaluate(title => {
    const card = Array.from(document.querySelectorAll("main article")).find(node => node.querySelector("h3")?.textContent === title);
    Array.from(card.querySelectorAll("button")).find(node => node.textContent === "Done").click();
  }, item.body.title);
  await waitFor(() => attention.get(item.source, item.id).state === "done", "manual Done");
  await deliver(item, { endpoint });
  assert.equal(attention.get(item.source, item.id).state, "done");
  const persisted = JSON.parse(fs.readFileSync(path.join(dataPath, "attention.json"), "utf8"));
  assert.equal(persisted.items.length, 2);
  console.log("PASS: two Codex runtimes -> async command hooks -> HTTP -> durable inbox -> rendered questions; one sound each, retry dedupe, manual Done, no focus change.");
  console.log(JSON.stringify({ dataPath, fixtures: results.map(result => result.evidence) }, null, 2));
}
const watchdog = setTimeout(() => { console.error("Codex smoke timed out"); app.exit(1); }, 90000);
let failed = false;
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
