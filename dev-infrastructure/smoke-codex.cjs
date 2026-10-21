// CODEX_CLI=/path/to/extension/codex.exe electron dev-infrastructure/smoke-codex.cjs
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");
require("./smoke-environment.cjs");
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
  const cases = [
    { asynchronous: false, title: "Blocking bridge test?" },
    { asynchronous: true, title: "Async answer after completion?" },
    { asynchronous: true, answerDuringTurn: true, title: "Async answer during active turn?" },
  ];
  const results = await Promise.all(cases.map(testCase => runQuestion({
    cli: process.env.CODEX_CLI, endpoint, ...testCase,
    onQuestion: async event => {
      const expected = toAttention(event);
      await waitFor(() => attention.get(expected.source, expected.id), "hook delivery");
      await waitFor(() => evaluate(title => Array.from(document.querySelectorAll("main article:not([hidden]) h3")).some(node => node.textContent === title),
        expected.body.title), "question rendered");
      assert.equal(attention.get(expected.source, expected.id).state, "pending");
      assert.equal(mainWindow.isVisible(), true, "Notifications open the inbox");
      assert.equal(mainWindow.isFocused(), false, "Notifications must not steal focus");
    },
    onPartialAnswer: async event => {
      const item = toAttention(event);
      assert.equal(attention.get(item.source, item.id).state, "pending", "Unanswered questions keep the request pending");
    },
    onAnswered: async event => {
      const item = toAttention(event);
      await waitFor(() => attention.get(item.source, item.id)?.state === "done", "automatic Done after answer");
      await waitFor(() => evaluate(title => !Array.from(document.querySelectorAll("main article:not([hidden]) h3")).some(node => node.textContent === title),
        item.body.title), "answered question removed from pending view");
      assert.equal(mainWindow.isVisible(), true, "Answers leave the inbox open");
      assert.equal(mainWindow.isFocused(), false, "Answer handling must not steal focus");
    },
  })));
  assert.equal(attention.list().items.length, 3, "Three independent runtime sessions create distinct entries");
  assert.deepEqual(sounds, ["icq", "icq", "icq"], "One sound per request");
  await Promise.all(results.flatMap(result => Array.from({ length: 3 }, () => deliver(toAttention(result.event), { endpoint }))));
  assert.equal(attention.list().items.length, 3);
  assert.equal(sounds.length, 3, "Retries never replay the sound");
  assert(attention.list().items.every(item => item.state === "done"));
  await evaluate(() => {
    Array.from(document.querySelectorAll('nav[aria-label="Attention views"] button')).find(node => node.textContent.startsWith("Done")).click();
  });
  await waitFor(() => evaluate(() => document.querySelectorAll("main article:not([hidden])").length === 3), "Done history rendered");
  const persisted = JSON.parse(fs.readFileSync(path.join(dataPath, "attention.json"), "utf8"));
  assert.equal(persisted.items.length, 3);
  assert(persisted.items.every(item => item.state === "done"));
  console.log("PASS: three Codex runtimes -> command hooks -> HTTP -> rendered inbox; blocking and async answers auto-dismiss, partial replies stay pending, Done history persists, one sound each, retry dedupe, no focus change.");
  console.log(JSON.stringify({ dataPath, fixtures: results.map(result => result.evidence) }, null, 2));
}
const watchdog = setTimeout(() => { console.error("Codex smoke timed out"); app.exit(1); }, 90000);
let failed = false;
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
