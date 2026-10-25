// Real Electron/preload/composer/service path; all Codex delivery is an isolated fixture.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path");
const { app } = require("electron");
require("./smoke-environment.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-instance-messages-"));
console.log("Instance message evidence:", directory);
app.setName(`Tray instance messages ${process.pid}`);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: directory, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
const rows = [42, 99].map((codexPid, i) => ({ codexPid, codexStartedAt: new Date(1000).toISOString(), vscodePid: codexPid + 1,
  vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 1, title: ["Breaditor", "Tray Platform"][i], workspace: ["D:/dev/breaditor-v2", "D:/dev/tray-platform"][i] }));
const owners = [[42, "a", "Edit the entity tools"], [99, "b", "Add message controls"], [99, "c", "Review the tests"]].map(([pid, id, title]) => ({
  processIdentity: `pid:${pid}:fixture`, threadId: id, title, turnId: "turn", firstObservedAt: 1100, lastObservedAt: 1200, rolloutPath: "D:/fixture.jsonl" }));
let application;
async function run() {
  application = await require("../dist/main/index.js").applicationReady;
  const { mainWindow: window, codexInstances, codexInstanceMessages, codexMessages, attention } = application;
  window.webContents.setAudioMuted(true);
  await codexInstances.refresh(); await codexInstances.refreshActivity();
  codexInstances.options.activity?.close(); codexInstances.options.activity = undefined;
  codexInstances.options.scan = async () => ({ instances: rows });
  const publish = async instances => { codexInstances.options.scan = async () => ({ instances }); await codexInstances.refresh(); };
  const before = attention.list().items.length;
  let mode = "idle", release;
  const sent = [];
  const client = () => ({ connect: async () => {}, close() {}, request: async (method, params, _version, owner) => {
    if (method === "thread-owner-discovery") return { method, resultType: "success", handledByClientId: "owner" };
    if (mode === "reject") throw Error("Delivery could not be confirmed. Check the conversation before sending again.");
    if (method === "thread-follower-steer-turn" && mode === "idle") return { resultType: "error", error: `Cannot steer conversation ${params.conversationId} because its active turn already ended` };
    const text = method === "thread-follower-steer-turn" ? params.input[0].text : params.turnStart.request.input[0].text;
    sent.push({ id: params.conversationId, text });
    if (mode === "hold") await new Promise(resolve => { release = resolve; });
    return { method, resultType: "success", handledByClientId: owner,
      result: { result: method === "thread-follower-steer-turn" ? { turnId: "turn" } : { turn: { id: "turn" } } } };
  } });
  const created = new Set();
  let hideSelected = false, emptyHistory = false;
  Object.assign(codexInstanceMessages.options, { verifyProcesses: async () => true, createClient: client,
    projects: {
      conversations: async instance => owners.filter(row => !emptyHistory && row.processIdentity.startsWith(`pid:${instance.codexPid}:`) && (!hideSelected || row.threadId !== "c"))
        .map(row => ({ id: row.threadId, title: row.title, lastActiveAt: row.lastObservedAt })),
      owns: id => created.has(id),
      send: async (_instance, id, text) => {
        if (mode === "reject") throw Error("Delivery could not be confirmed. Check the conversation before sending again.");
        id ||= `new-${created.size}`; created.add(id); sent.push({ id, text });
        return { sessionId: id, turnId: "turn", delivery: "started" };
      },
    },
  });
  codexMessages.createClient = client;
  await publish(rows);
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  await wait("instance menus", () => evaluate(() => document.querySelectorAll("[data-instance-menu-toggle]").length === 2));
  await evaluate(() => document.querySelector('[role="tab"][aria-controls="codex-instances"]').click());
  assert(await evaluate(() => {
    const button = document.querySelector("[data-instance-menu-toggle]").getBoundingClientRect();
    const pane = document.querySelector("#codex-instances [data-table-scroll]").getBoundingClientRect();
    return button.width >= 44 && button.left >= pane.left && button.right <= pane.right && pane.right - button.right <= 12;
  }), "Instance menu is right-aligned and visible without horizontal scrolling");
  assert(await evaluate(() => document.querySelector("[data-instance-menu]").hidden), "Message starts inside a closed menu");
  await evaluate(() => {
    const toggle = document.querySelector("[data-instance-menu-toggle]"); toggle.focus();
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert(await evaluate(() => document.activeElement.matches('[data-instance-menu] [role="menuitem"]')));
  await publish(rows);
  assert(await evaluate(() => !document.querySelector("[data-instance-menu]").hidden && !!document.querySelector('[data-instance-menu-toggle][aria-expanded="true"]')),
    "Live inventory updates preserve the open menu");
  await evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert(await evaluate(() => document.querySelector("[data-instance-menu]").hidden && document.activeElement.matches("[data-instance-menu-toggle]")),
    "Escape closes the menu and restores focus");
  await evaluate(() => document.querySelector('[data-codex-pid="99"] [data-instance-menu-toggle]').click());
  assert(await evaluate(() => {
    const menu = document.querySelector("[data-instance-menu]").getBoundingClientRect();
    return menu.width > 0 && menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight;
  }), "Menu escapes the table scroller and stays in the viewport");
  window.showInactive(); await sleep(100);
  fs.writeFileSync(path.join(directory, "instance-message-actions.png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  await evaluate(() => document.querySelector("h2").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  assert(await evaluate(() => document.querySelector("[data-instance-menu]").hidden), "Outside pointer closes the menu");
  const open = pid => evaluate(pid => {
    const toggle = document.querySelector(`[data-codex-pid="${pid}"] [data-instance-menu-toggle]`);
    toggle.scrollIntoView({ block: "center" }); toggle.click();
    document.querySelector("[data-instance-menu] [data-message-codex]").click();
  }, pid);
  const read = () => evaluate(() => {
    const panel = document.querySelector("[data-codex-instance-composer]");
    return { hidden: panel.hidden, text: panel.querySelector("textarea").value, selected: panel.querySelector("select").value,
      disabled: panel.querySelector('[type="submit"]').disabled, status: panel.querySelector(':scope > form > [role="status"]').textContent,
      error: panel.querySelector(':scope > form > [role="alert"]').textContent, choices: panel.querySelector("select").options.length };
  });
  const type = text => evaluate(text => { const input = document.querySelector("[data-codex-instance-composer] textarea"); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  const send = () => evaluate(() => document.querySelector('[data-codex-instance-composer] [type="submit"]').click());
  await open(42); await wait("single conversation plus new", async () => (await read()).choices === 2);
  assert.equal((await read()).selected, "", "New conversation is the default, even with one saved thread");
  const choose = id => evaluate(id => { const select = document.querySelector("[data-codex-instance-composer] select"); select.value = id; select.dispatchEvent(new Event("change")); }, id);
  await choose("a");
  await type("Preserve this draft");
  await publish([...rows].reverse());
  await evaluate(() => document.querySelector('[data-sort-column="title"]').click());
  assert.equal((await read()).text, "Preserve this draft");
  await open(99); await wait("multiple conversations", async () => (await read()).choices === 3);
  assert.equal((await read()).selected, ""); await type("Second draft"); assert(!(await read()).disabled);
  await open(42); assert.equal((await read()).text, "Preserve this draft");
  await publish([rows[1]]); await wait("removed instance", async () => (await read()).error.includes("closed or restarted"));
  assert((await read()).disabled); assert.equal((await read()).text, "Preserve this draft");
  await publish(rows); await wait("instance returned", async () => !(await read()).disabled);
  const literal = "Continue caf\u00e9\n<script>literal</script> $(literal)"; await type(literal);
  await evaluate(() => document.querySelector("[data-codex-instance-composer] textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  await wait("follow-up sent", async () => (await read()).status === "Sent to Codex as a follow-up.");
  assert.deepEqual(sent, [{ id: "a", text: literal }]); assert.equal((await read()).text, "");
  await open(99); assert.equal((await read()).text, "Second draft");
  await evaluate(() => { const select = document.querySelector("[data-codex-instance-composer] select"); select.value = "c"; select.dispatchEvent(new Event("change")); });
  mode = "hold"; await send(); await wait("held send", () => release);
  assert((await read()).disabled); await send(); assert.equal(sent.length, 2);
  await open(42); await type("Keep this other draft"); release();
  await sleep(100); assert.equal((await read()).text, "Keep this other draft");
  await open(99); await wait("steering sent", async () => (await read()).status === "Sent to the active Codex turn.");
  assert.equal((await read()).text, ""); assert.deepEqual(sent[1], { id: "c", text: "Second draft" });
  hideSelected = true;
  await evaluate(() => [...document.querySelectorAll("[data-codex-instance-composer] button")].find(button => button.textContent === "Refresh conversations").click());
  await wait("missing selection", async () => (await read()).selected === "__missing__");
  await type("New project conversation"); assert((await read()).disabled, "Refresh cannot silently retarget a selected draft to New");
  await choose(""); mode = "idle"; await send();
  await wait("new conversation sent", async () => (await read()).selected === "new-0");
  assert.deepEqual(sent[2], { id: "new-0", text: "New project conversation" });
  assert.equal((await read()).text, "");
  await choose(""); await type("Another new conversation");
  await send(); await wait("new option remains available", async () => (await read()).selected === "new-1");
  assert.deepEqual(sent[3], { id: "new-1", text: "Another new conversation" });
  await choose(""); emptyHistory = true;
  await evaluate(() => [...document.querySelectorAll("[data-codex-instance-composer] button")].find(button => button.textContent === "Refresh conversations").click());
  await wait("empty project history", async () => (await read()).choices === 1);
  await type("First message in an empty project"); assert(!(await read()).disabled);
  await send(); await wait("empty project sent", async () => (await read()).selected === "new-2");
  assert.deepEqual(sent[4], { id: "new-2", text: "First message in an empty project" });
  mode = "reject"; await type("Keep failed draft"); await send();
  await wait("send failed", async () => (await read()).error.includes("Check the conversation"));
  assert.equal((await read()).text, "Keep failed draft");
  await evaluate(() => [...document.querySelectorAll("[data-codex-instance-composer] button")].find(button => button.textContent === "Close").click());
  assert((await read()).hidden); await open(99); assert.equal((await read()).text, "Keep failed draft");
  assert.equal(attention.list().items.length, before, "Composing and sending never create an inbox notification");
  window.showInactive(); await sleep(150);
  fs.writeFileSync(path.join(directory, "instance-composer.png"), (await window.webContents.capturePage()).toPNG());
  console.log("PASS instance composer, real preload IPC, conversation selection, draft retention, process removal, idle/active delivery, failure and duplicate prevention:", directory);
}
const watchdog = setTimeout(() => { console.error("Instance message smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); if (application) { app.once("will-quit", () => app.exit(code)); app.quit(); } else app.exit(code); }
