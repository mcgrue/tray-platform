// Desktop IPC + phone HTTP + installed Codex runtime. Isolated config/files and
// deterministic localhost responses; no live conversations or external inference.
const assert = require("assert").strict, fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const { app, BrowserWindow } = require("electron");
const { createMessageRuntime } = require("./codex-message-runtime.cjs");
require("./smoke-environment.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-attachments-smoke-")), root = path.join(__dirname, "..");
console.log("Attachment evidence:", directory);
app.setName(`Tray attachments ${process.pid}`);
Object.assign(process.env, { TRAY_PLATFORM_USER_DATA: directory, TRAY_PLATFORM_PORT: "0", WATCH_MODE: "", BREADITOR_DEV_MODE: "" });
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "attention-service", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root }, outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node" });
const { createAttentionWeb, AttentionError, WebReceipts, WebPushService } = require(path.join(directory, "backend.cjs"));
let application, runtime, phone, web, proxy, push, dropNext = false;
const sockets = new Set(), delivered = [], errors = [];
const instanceComposer = "[data-codex-instance-composer]", inboxId = "completion-" + "a".repeat(64);
const inboxComposer = `article[data-attention-key='${JSON.stringify(["codex", inboxId])}'] [data-codex-message]`;
const image = fs.readFileSync(path.join(root, "src/web/icon-192.png")).toString("base64");
const source = Buffer.from("// café fixture\nexport const attached = true;\n").toString("base64");
const files = [{ name: "example.ts", type: "text/plain", base64: source }, { name: "picture.png", type: "image/png", base64: image }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 20000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw Error("Timeout: " + label); }
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const state = (window, selector) => evaluate(window, selector => {
  const node = document.querySelector(selector); if (!node) return null;
  return { count: node.querySelectorAll("[data-attachment-id]").length, imageIcons: node.querySelectorAll('[data-attachment-kind="image"]').length,
    text: node.querySelector("textarea").value, selected: node.querySelector("select")?.value,
    disabled: node.querySelector('button[type="submit"]').matches(":disabled"), status: node.querySelector(':scope > form > [role="status"]')?.textContent,
    error: node.querySelector(':scope > form > [role="alert"]')?.textContent, toast: document.querySelector('[data-toast]:not([hidden])')?.textContent };
}, selector);
const attach = (window, selector, input = files, kind = "picker") => evaluate(window, (selector, input, kind) => {
  const form = document.querySelector(selector + " form"), transfer = new DataTransfer();
  for (const file of input) transfer.items.add(new File([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], file.name, { type: file.type }));
  if (kind === "picker") { const picker = form.querySelector('input[type="file"]'); picker.files = transfer.files; picker.dispatchEvent(new Event("change", { bubbles: true })); }
  else if (kind === "drop") form.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  else form.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
}, selector, input, kind);
const send = (window, selector) => evaluate(window, selector => document.querySelector(selector + ' button[type="submit"]').click(), selector);
const type = (window, selector, text) => evaluate(window, (selector, text) => { const input = document.querySelector(selector + " textarea"); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }, selector, text);
async function openInstance(window, pid = 42) {
  await evaluate(window, pid => {
    document.querySelector('[role="tab"][aria-controls="codex-instances"]').click();
    const toggle = [...document.querySelectorAll("[data-instance-menu-toggle]")].find(button => button.getAttribute("aria-label").includes(`PID ${pid}`));
    toggle.scrollIntoView({ block: "center" }); toggle.click(); document.querySelector("[data-message-codex]").click();
  }, pid);
  await wait("conversation choices", () => evaluate(window, () => !document.querySelector('[data-codex-instance-composer] select').disabled));
}
async function openInbox(window) {
  await evaluate(window, selector => {
    document.querySelector('[role="tab"][aria-controls="attention-inbox"]').click();
    const card = document.querySelector(selector).closest("article"), toggle = card.querySelector("[data-attention-disclosure]");
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    card.scrollIntoView({ block: "center" });
  }, inboxComposer);
}
async function screenshot(window, name, selector) {
  await evaluate(window, selector => document.querySelector(selector).scrollIntoView({ block: "center" }), selector);
  window.showInactive(); await sleep(100); fs.writeFileSync(path.join(directory, name + ".png"), (await window.webContents.capturePage()).toPNG()); window.hide();
}
async function checkActions(window, selector) {
  assert(await evaluate(window, selector => {
    const composer = document.querySelector(selector), row = composer.querySelector("[data-composer-actions]"),
      attach = row.querySelector("[data-attach-files]"), send = row.querySelector('button[type="submit"]');
    const a = attach.getBoundingClientRect(), b = send.getBoundingClientRect(), r = row.getBoundingClientRect();
    let pickerOpened = false;
    composer.querySelector('input[type="file"]').addEventListener("click", event => { event.preventDefault(); pickerOpened = true; }, { once: true });
    attach.click();
    return pickerOpened && attach.getAttribute("aria-label") === "Attach files or images" &&
      Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 1 && Math.abs(b.right - r.right) < 1 &&
      Math.abs(b.left - a.right - 8) < 1 && !composer.textContent.includes("Drop files or paste images");
  }, selector), "Paperclip and send share a right-aligned row; paperclip opens picker without reminder text");
}
async function checkPreviews(window, selector, name) {
  assert(await evaluate(window, selector => {
    const root = document.querySelector(selector + " [data-codex-attachments]");
    return !root.querySelector("img") && root.querySelectorAll("[data-attachment-open]").length === 2;
  }, selector), "Attachments render as icons without inline images");
  await evaluate(window, selector => document.querySelector(selector + ' [data-attachment-kind="image"]').click(), selector);
  await wait("large image preview", () => evaluate(window, () => document.querySelector("[data-attachment-preview][open] img")?.naturalWidth > 0));
  assert(await evaluate(window, () => {
    const preview = document.querySelector("[data-attachment-preview]"), metadata = preview.querySelector("[data-attachment-metadata]");
    return metadata.querySelector("strong").textContent === "picture.png" && /KiB| B/.test(metadata.children[1].textContent) &&
      preview.querySelector("[data-attachment-remove]").getAttribute("aria-label") === "Remove picture.png";
  }), "Image preview has filename/size overlays and a labeled remove action");
  await screenshot(window, name + "-preview", selector);
  await wait("preview removal available after visibility reconnect", () => evaluate(window, () => !document.querySelector("[data-attachment-remove]").disabled));
  await evaluate(window, () => document.querySelector("[data-attachment-back]").click());
  await evaluate(window, selector => document.querySelector(selector + ' [data-attachment-kind="file"]').click(), selector);
  await wait("source file preview", () => evaluate(window, () => document.querySelector("[data-attachment-preview] pre")?.textContent.includes("export const attached = true")));
  await evaluate(window, () => document.querySelector("[data-attachment-back]").click());
  assert.equal((await state(window, selector)).count, 2, "Closing image/file previews preserves the draft");
}
const removeAttachments = (window, selector) => evaluate(window, selector => {
  for (const button of document.querySelectorAll(selector + " [data-attachment-open]")) {
    button.click(); document.querySelector("[data-attachment-preview] [data-attachment-remove]").click();
  }
}, selector);
async function run() {
  assert(process.env.CODEX_CLI, "Set CODEX_CLI to the installed Codex executable");
  runtime = await createMessageRuntime(directory, process.env.CODEX_CLI);
  application = await require("../dist/main/index.js").applicationReady;
  const { attention, codexMessages, codexProjects, codexInstances, codexInstanceMessages, codexAttachments, mainWindow: desktop } = application;
  desktop.webContents.setAudioMuted(true);
  await codexInstances.refresh(); await codexInstances.refreshActivity(); codexInstances.options.activity?.close(); codexInstances.options.activity = undefined;
  const rows = [42, 84].map(pid => ({ codexPid: pid, codexStartedAt: "2026-10-25T10:00:00Z", vscodePid: pid + 1, vscodeStartedAt: "2026-10-25T09:00:00Z", vscodeMainPid: 1, title: "Attachment fixture " + pid, workspace: runtime.cwd }));
  codexInstances.options.scan = async () => ({ instances: rows }); await codexInstances.refresh();
  codexInstanceMessages.options.verifyProcesses = async () => true;
  codexProjects.options.processes = async () => rows.flatMap(row => [{ pid: row.codexPid, startedAt: row.codexStartedAt, parentPid: row.vscodePid, name: "codex.exe", executablePath: process.env.CODEX_CLI }, { pid: row.vscodePid, startedAt: row.vscodeStartedAt, parentPid: 1, name: "Code.exe" }]);
  codexProjects.options.createClient = (_exe, _cwd, callbacks) => {
    const stop = runtime.onNotification(callbacks.notification);
    return { request: async (method, params) => { if (["turn/start", "turn/steer"].includes(method)) delivered.push({ method, params }); return runtime.rpc(method, params); }, close: stop };
  };
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  // The fixture's HTTP bundle has its own Error constructor; preserve the main
  // bundle's typed errors at this test-only boundary. Production is one bundle.
  const attachmentTransport = Object.fromEntries(["upload", "message"].map(method => [method, async (...args) => {
    try { return await codexAttachments[method](...args); } catch (error) { if (error.status) throw new AttentionError(error.message, error.status); throw error; }
  }]));
  web = createAttentionWeb({ config, attention, receipts, push, attachments: attachmentTransport, assets: path.join(root, "dist/web"), codex: { instances: codexInstances, messages: codexInstanceMessages },
    operations: { message: (source, id, value) => codexMessages.send(attention.get(source, id), value), questions: async () => [], answer: async () => { throw Error("Unexpected answer"); } } });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method, headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => {
      if (dropNext && req.method === "POST" && req.url.endsWith("/messages")) { dropNext = false; response.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{"); return; }
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    }); upstream.on("error", () => { res.writeHead(502); res.end(); }); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 390, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  for (const window of [phone, desktop]) window.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  await phone.loadURL(config.origin); await wait("phone connected", () => evaluate(phone, () => !document.querySelector("#online-controls").disabled));
  await wait("instances", () => evaluate(desktop, () => document.querySelectorAll("[data-instance-menu-toggle]").length === 2));

  await openInstance(desktop); await attach(desktop, instanceComposer);
  await wait("desktop image icon", async () => (await state(desktop, instanceComposer)).imageIcons === 1);
  await checkActions(desktop, instanceComposer);
  await checkPreviews(desktop, instanceComposer, "desktop-instance");
  await attach(desktop, instanceComposer, Array.from({ length: 4 }, () => files[0]));
  await wait("desktop attachment count toast", async () => (await state(desktop, instanceComposer)).toast?.includes("Too many attachments"));
  assert.equal((await state(desktop, instanceComposer)).count, 2, "Rejected batch preserves existing attachments");
  await evaluate(desktop, () => document.querySelector("[data-toast] button").click());
  assert.equal((await state(desktop, instanceComposer)).disabled, false, "Attachment-only message is sendable");
  await openInstance(desktop, 84); assert.equal((await state(desktop, instanceComposer)).count, 0);
  await openInstance(desktop); assert.equal((await state(desktop, instanceComposer)).count, 2, "Draft files stay with their instance");
  await screenshot(desktop, "desktop-attachments", instanceComposer);
  await send(desktop, instanceComposer); await wait("desktop new conversation", async () => Boolean((await state(desktop, instanceComposer)).selected) && (await state(desktop, instanceComposer)).count === 0);
  const session = (await state(desktop, instanceComposer)).selected;
  await wait("first turn completed", () => runtime.completed.size === 1);
  assert(delivered[0].params.input.some(part => part.type === "localImage"));
  assert(JSON.stringify(runtime.requests).includes('"type":"input_image"'), "Image pixels reach the actual runtime provider");
  assert(JSON.stringify(runtime.requests).includes("example.ts"));
  await attention.upsert("codex", inboxId, { title: "Codex done: attachment fixture", project: runtime.cwd, codexSessionId: session });
  await wait("inbox composers", () => evaluate(phone, selector => !!document.querySelector(selector), inboxComposer));
  await openInbox(desktop); await attach(desktop, inboxComposer, [files[0]], "drop"); await attach(desktop, inboxComposer, [files[1]], "paste");
  await checkActions(desktop, inboxComposer);
  await checkPreviews(desktop, inboxComposer, "desktop-inbox");
  await type(desktop, inboxComposer, "Desktop follow-up"); await send(desktop, inboxComposer);
  await wait("desktop inbox delivered", async () => (await state(desktop, inboxComposer)).count === 0);
  await wait("desktop follow-up complete", () => runtime.completed.size === 2);

  await openInstance(phone); await attach(phone, instanceComposer); await checkActions(phone, instanceComposer);
  await checkPreviews(phone, instanceComposer, "phone-instance"); await send(phone, instanceComposer);
  await wait("phone new conversation", async () => Boolean((await state(phone, instanceComposer)).selected) && (await state(phone, instanceComposer)).count === 0);
  await wait("phone new turn complete", () => runtime.completed.size === 3);
  await openInbox(phone); await attach(phone, inboxComposer, [files[0]], "drop"); await attach(phone, inboxComposer, [files[1]], "paste");
  await type(phone, inboxComposer, "Phone follow-up with attachments");
  await attention.upsert("fixture", "update", { title: "Snapshot while files are attached" }); await sleep(100);
  await openInstance(phone); await openInbox(phone); assert.equal((await state(phone, inboxComposer)).count, 2);
  await checkActions(phone, inboxComposer);
  await checkPreviews(phone, inboxComposer, "phone-inbox");
  assert(await evaluate(phone, () => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(phone, "phone-attachments", inboxComposer);
  await evaluate(phone, selector => { dispatchEvent(new Event("offline")); document.querySelector(selector + " textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); }, inboxComposer);
  assert.equal(delivered.length, 3, "Offline keyboard send cannot bypass disabled controls");
  await evaluate(phone, () => dispatchEvent(new Event("online"))); await wait("phone reauthorized", () => evaluate(phone, () => !document.querySelector("#online-controls").disabled));
  dropNext = true; await send(phone, inboxComposer);
  await wait("lost receipt retains attachments", async () => (await state(phone, inboxComposer)).error.includes("Delivery is unconfirmed"));
  assert.equal((await state(phone, inboxComposer)).count, 2);
  await evaluate(phone, () => document.querySelector("#check-delivery").click());
  await wait("receipt clears exact sent draft", async () => (await state(phone, inboxComposer)).count === 0 && (await state(phone, inboxComposer)).text === "");
  assert.equal(delivered.length, 4, "Receipt reconciliation does not resend files or message");
  await wait("phone follow-up complete", () => runtime.completed.size === 4);

  await attach(phone, inboxComposer, [{ name: "broken.png", type: "image/png", base64: source }]); await send(phone, inboxComposer);
  await wait("bad image feedback", async () => (await state(phone, inboxComposer)).error.includes("cannot be decoded"));
  assert.equal((await state(phone, inboxComposer)).count, 1); assert.equal(delivered.length, 4);
  await removeAttachments(phone, inboxComposer);
  assert.equal((await state(phone, inboxComposer)).count, 0);
  await evaluate(phone, selector => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "too-large.bin"));
    document.querySelector(selector + " form").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, inboxComposer);
  await wait("oversize toast", async () => (await state(phone, inboxComposer)).toast?.includes("That file is too large"));
  assert((await state(phone, inboxComposer)).toast.includes("5 files, 10 MiB each and 20 MiB total"));
  assert.equal((await state(phone, inboxComposer)).count, 0);
  assert(await evaluate(phone, () => {
    const box = document.querySelector('[data-toast]:not([hidden])').getBoundingClientRect();
    return box.left >= 15 && box.right <= document.documentElement.clientWidth - 15;
  }), "Toast fits the phone viewport with margins, including a visible scrollbar");
  await screenshot(phone, "phone-attachment-limit", inboxComposer);
  await evaluate(phone, () => document.querySelector("[data-toast] button").click());
  assert.equal((await state(phone, inboxComposer)).toast, undefined, "Toast can be dismissed");
  await attach(phone, inboxComposer, Array.from({ length: 5 }, (_, index) => ({ ...files[0], name: `source-${index}.ts` })));
  assert.equal((await state(phone, inboxComposer)).count, 5, "Five files are accepted");
  await attach(phone, inboxComposer, [files[0]]);
  await wait("sixth file toast", async () => (await state(phone, inboxComposer)).toast?.includes("Too many attachments"));
  assert.equal((await state(phone, inboxComposer)).count, 5, "Sixth file is rejected without changing the draft");
  await removeAttachments(phone, inboxComposer);
  await evaluate(phone, selector => {
    const transfer = new DataTransfer();
    for (let i = 0; i < 3; i++) transfer.items.add(new File([new Uint8Array(8 * 1024 * 1024)], `large-${i}.bin`));
    document.querySelector(selector + " form").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, inboxComposer);
  await wait("combined size toast", async () => (await state(phone, inboxComposer)).toast?.includes("too large together"));
  assert.equal((await state(phone, inboxComposer)).count, 0);
  assert.equal(await evaluate(phone, () => document.querySelectorAll('[data-toast]:not([hidden])').length), 1, "Repeated warnings replace the toast");

  runtime.holdNextResponse(); await openInbox(desktop); await type(desktop, inboxComposer, "Start held turn"); await send(desktop, inboxComposer);
  await wait("held turn started", async () => delivered.length === 5 && (await state(desktop, inboxComposer)).text === "" && JSON.stringify(runtime.requests).includes("Start held turn"));
  await attach(desktop, inboxComposer, [files[1]]); await type(desktop, inboxComposer, "Steer with image"); await send(desktop, inboxComposer);
  await wait("image steer accepted", async () => delivered.length === 6 && (await state(desktop, inboxComposer)).count === 0);
  assert.equal(delivered[5].method, "turn/steer");
  runtime.releaseResponse();
  await wait("steered image turn completed", () => runtime.completed.size === 5 && JSON.stringify(runtime.requests).includes("Steer with image"));
  await wait("toast auto-dismisses", async () => !(await state(phone, inboxComposer)).toast);
  for (const request of delivered.filter((_, index) => index !== 4)) {
    const png = request.params.input.find(part => part.type === "localImage"); assert(png); assert(fs.readFileSync(png.path).equals(Buffer.from(image, "base64")));
  }
  const records = Object.values(codexAttachments.records); assert.equal(records.length, 9); assert.equal(new Set(records.map(record => record.filename)).size, 9);
  assert.equal(errors.filter(message => !/Failed to load resource/.test(message)).length, 0, errors.join("\n"));
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true, delivered, checks: ["desktop and phone instance/inbox composers", "attachment-only new threads", "drop and paste", "icon-only attachment strip", "image/source previews with metadata overlays", "draft isolation and snapshots", "actual image input", "exact source copies", "offline controls", "lost receipt recovery without replay", "invalid image retains draft", "file size limit", "preview corner removal", "active turn image steering", "right-aligned actions and picker button", "file count and combined size limits preserve drafts", "limit toasts replace and dismiss"], directory }, null, 2));
  console.log("PASS desktop and phone attachments with actual Codex runtime:", directory);
}
const watchdog = setTimeout(() => { console.error("Attachment smoke timed out"); finish(1); }, 120000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
async function finish(code) {
  clearTimeout(watchdog); phone?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); push?.close();
  await runtime?.close(); if (application) { app.once("will-quit", () => app.exit(code)); app.quit(); } else app.exit(code);
}
