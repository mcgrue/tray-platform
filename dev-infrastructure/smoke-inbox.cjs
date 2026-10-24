// Run after yarn pre-build: electron dev-infrastructure/smoke-inbox.cjs
// Uses isolated, retained user data and does not activate other applications.
const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { app, shell } = require("electron");
require("./smoke-environment.cjs");

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "tray-platform-inbox-smoke-"));
app.setName(`Tray Platform inbox smoke ${process.pid}`);
app.setPath("userData", dataPath);
process.env.TRAY_PLATFORM_USER_DATA = dataPath;
process.env.TRAY_PLATFORM_PORT = "0";
process.env.WATCH_MODE = "";
process.env.BREADITOR_DEV_MODE = "";
const opened = [];
shell.openExternal = async url => { opened.push(url); };
console.log(`Smoke user data retained at: ${dataPath}`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(description, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${description}`);
}

async function run() {
  const application = await require(path.join(__dirname, "../dist/main/index.js")).applicationReady;
  assert(application, "Isolated application acquires its instance lock");
  const { mainWindow, server, attention } = application;
  if (!server.listening) await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const port = server.address().port;
  const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const request = (method, pathname, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => {
        let value;
        try { value = JSON.parse(text); } catch { value = text; }
        resolve({ status: res.statusCode, value });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("HTTP smoke request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
  const visible = title => evaluate(expected => Array.from(document.querySelectorAll("main article")).some(card =>
    !card.hidden && card.querySelector("h3")?.textContent === expected), title);
  const click = (title, label) => evaluate((expected, action) => {
    const card = Array.from(document.querySelectorAll("main article")).find(node => !node.hidden && node.querySelector("h3")?.textContent === expected);
    const control = card && Array.from(card.querySelectorAll("button")).find(node => !node.hidden && node.textContent === action);
    if (!control || control.disabled) throw new Error(`Missing enabled ${action} for ${expected}`);
    control.click();
  }, title, label);
  const tab = name => evaluate(expected => {
    const control = Array.from(document.querySelectorAll("main nav button")).find(node => node.textContent.startsWith(expected));
    if (!control) throw new Error(`Missing ${expected} tab`);
    control.click();
  }, name);
  const hasState = state => attention.list().items.some(item => item.source === "smoke" && item.id === "build" && item.state === state);

  await waitFor("inbox and audio mount", () => evaluate(() => document.querySelector("main h2")?.textContent.includes("Attention inbox") && document.querySelectorAll("audio").length > 0));
  assert.equal(mainWindow.isVisible(), true, "Startup opens the attention inbox");
  mainWindow.hide();
  await waitFor("hidden inbox loses focus", () => !mainWindow.isVisible() && !mainWindow.isFocused());
  await evaluate(() => { window.__smokeOriginalAudio = document.querySelector("audio"); });
  let response = await request("PUT", "/api/attention/smoke/build", { title: "Smoke build", description: "Resume this task", destination: { kind: "url", url: "https://example.com/smoke" } });
  assert.equal(response.status, 200);
  await waitFor("created item rendered", () => visible("Smoke build"));
  assert.equal(mainWindow.isVisible(), true, "Incoming events open the inbox");
  assert.equal(mainWindow.isFocused(), false, "Incoming events must not steal focus");
  await click("Smoke build", "Go");
  await waitFor("URL Go reaches main process", () => opened.length === 1);
  assert.equal(opened[0], "https://example.com/smoke");
  assert.equal(hasState("pending"), true, "Go retains pending disposition");

  // A snapshot updates the existing card without recreating unrelated audio.
  await evaluate(() => { window.__smokeOriginalCard = document.querySelector("main article"); });
  response = await request("PUT", "/api/attention/smoke/build", { title: "Smoke build updated", destination: { kind: "url", url: "https://example.com/smoke" } });
  assert.equal(response.status, 200);
  await waitFor("idempotent item update", () => visible("Smoke build updated"));
  assert.equal(attention.list().items.length, 1);
  assert.equal(await evaluate(() => document.querySelector("main article") === window.__smokeOriginalCard), true);
  assert.equal(await evaluate(() => document.querySelector("audio") === window.__smokeOriginalAudio), true, "Audio node survives snapshots");

  await click("Smoke build updated", "Snooze");
  await waitFor("snooze persisted", () => hasState("snoozed"));
  await tab("Snoozed");
  await waitFor("snoozed view", () => visible("Smoke build updated"));
  await click("Smoke build updated", "Reopen");
  await waitFor("reopen persisted", () => hasState("pending"));
  await tab("Pending");
  await waitFor("pending view", () => visible("Smoke build updated"));
  await click("Smoke build updated", "Done");
  await waitFor("done persisted", () => hasState("done"));
  await tab("Done");
  await waitFor("done view", () => visible("Smoke build updated"));
  await click("Smoke build updated", "Reopen");
  await waitFor("done reopened", () => hasState("pending"));
  await tab("Pending");

  response = await request("GET", "/MAC");
  assert.equal(response.status, 200);
  assert.equal(attention.list().items.length, 1, "Legacy sound does not become an attention item");
  assert.equal(await evaluate(() => document.querySelector("audio") === window.__smokeOriginalAudio), true);

  response = await request("PUT", "/api/attention/smoke/missing", { title: "Missing destination" });
  assert.equal(response.status, 200);
  await waitFor("missing destination rendered", () => visible("Missing destination"));
  assert.equal(await evaluate(() => {
    const card = Array.from(document.querySelectorAll("main article")).find(node => node.querySelector("h3")?.textContent === "Missing destination");
    return Array.from(card.querySelectorAll("button")).find(node => node.textContent === "Go").disabled && card.textContent.includes("No destination");
  }), true);
  response = await request("PUT", "/api/attention/smoke/stale", { title: "Stale destination", destination: { kind: "window", hwnd: "2147483647", pid: 2147483647, processStartedAt: "2000-01-01T00:00:00.000Z" } });
  assert.equal(response.status, 200);
  await waitFor("stale destination rendered", () => visible("Stale destination"));
  await click("Stale destination", "Go");
  await waitFor("stale destination error visible", () => evaluate(() => {
    const card = Array.from(document.querySelectorAll("main article")).find(node => node.querySelector("h3")?.textContent === "Stale destination");
    return Boolean(card.querySelector(':scope > [role="alert"]').textContent);
  }));
  assert.equal(attention.list().items.find(item => item.id === "stale").state, "pending");

  assert.equal(await evaluate(() => [...document.querySelectorAll("main article summary, main article button")]
    .some(node => ["Choose destination", "Refresh windows", "Save window", "Save link"].includes(node.textContent))), false,
    "Attention cards no longer expose destination editing");

  await new Promise(resolve => { mainWindow.webContents.once("did-finish-load", resolve); mainWindow.reload(); });
  await waitFor("reloaded inbox restores all items", () => evaluate(() => document.querySelectorAll("main article:not([hidden])").length === 3));
  assert.equal(await evaluate(() => document.querySelectorAll("main").length), 1);
  assert.equal(await evaluate(() => document.querySelectorAll("#soundboard").length), 1);
  assert.equal(attention.list().items.length, 3);
  assert(fs.existsSync(path.join(dataPath, "attention.json")), "Durable store exists");
  console.log("PASS: inbox DOM, idempotent HTTP events, audio preservation, Go, snooze, Done/Reopen, destination errors/editor removal, and reload persistence");
}

let failed = false;
const watchdog = setTimeout(() => { console.error("Inbox smoke exceeded 100 seconds"); app.exit(1); }, 100000);
run().catch(error => { failed = true; console.error(error); }).finally(() => {
  clearTimeout(watchdog);
  app.once("will-quit", () => app.exit(failed ? 1 : 0));
  app.quit();
});
