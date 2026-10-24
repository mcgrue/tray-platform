// Run after yarn pre-build. Real desktop + phone renderers with isolated data.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow, shell } = require("electron");
require("./smoke-environment.cjs");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-markdown-smoke-"));
app.setName(`Tray Markdown smoke ${process.pid}`);
app.setPath("userData", directory);
process.env.TRAY_PLATFORM_USER_DATA = directory;
process.env.TRAY_PLATFORM_PORT = "0";
process.env.WATCH_MODE = "";
process.env.BREADITOR_DEV_MODE = "";
const opened = [];
shell.openExternal = async url => { opened.push(url); };
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, WebReceipts, WebPushService } = require(path.join(directory, "backend.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const markdown = [
  "## Build complete", "", "**Ready** for *review*. See [pull request](https://example.com/review).", "",
  "- Tests passed", "- Phone layout checked", "", "> Keep your current draft.", "",
  "```ts", "const escaped = '<script>never run</script>';", "const longLine = '" + "x".repeat(160) + "';", "```", "",
  "| Check | Result |", "| --- | --- |", "| Markdown | Passed |", "",
  "<img src=x onerror=alert(1)>", "[Unsafe](javascript:alert%281%29)",
].join("\n");
let web, proxy, phone, desktop;
const sockets = new Set();
async function run() {
  const application = await require(path.join(root, "dist/main/index.js")).applicationReady;
  const { attention, mainWindow } = application;
  desktop = mainWindow;
  await wait("desktop ready", () => evaluate(desktop, () => Boolean(document.querySelector("[data-attention-inbox]"))));
  await attention.upsert("codex", "completion-" + "a".repeat(64), { title: "Markdown fixture", codexSessionId: "fixture", description: markdown });

  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  const push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: {} });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 360, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await phone.loadURL(config.origin);
  for (const [name, window] of [["desktop", desktop], ["phone", phone]]) {
    await wait(name + " markdown", () => evaluate(window, () => Boolean(document.querySelector(".attention-markdown table"))));
    assert.deepEqual(await evaluate(window, () => {
      const body = document.querySelector(".attention-markdown");
      return { heading: body.querySelector("h2").textContent, strong: body.querySelector("strong").textContent,
        items: body.querySelectorAll("li").length, unsafe: body.querySelectorAll("script,img,[onerror],a[href^='javascript:']").length,
        overflow: document.documentElement.scrollWidth > innerWidth, target: body.querySelector("a").target };
    }), { heading: "Build complete", strong: "Ready", items: 2, unsafe: 0, overflow: false, target: "_blank" });
    await evaluate(window, () => {
      window.__markdownBefore = document.querySelector(".attention-markdown a");
      const input = window.__markdownBefore.closest("article").querySelector("textarea");
      input.value = "Preserved draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    window.showInactive(); await sleep(150);
    fs.writeFileSync(path.join(directory, name + ".png"), (await window.webContents.capturePage()).toPNG()); window.hide();
  }
  await attention.upsert("fixture", "other", { title: "Concurrent update" });
  for (const window of [desktop, phone]) {
    await wait("snapshot update", () => evaluate(window, () => document.querySelectorAll("article").length === 2));
    assert.deepEqual(await evaluate(window, () => ({ sameLink: window.__markdownBefore === document.querySelector(".attention-markdown a"),
      draft: window.__markdownBefore.closest("article").querySelector("textarea").value })), { sameLink: true, draft: "Preserved draft" });
  }
  const desktopURL = desktop.webContents.getURL();
  await evaluate(desktop, () => document.querySelector(".attention-markdown a").click());
  await wait("external link", () => opened.length === 1);
  assert.deepEqual(opened, ["https://example.com/review"]);
  assert.equal(desktop.webContents.getURL(), desktopURL);
  assert.equal(BrowserWindow.getAllWindows().length, 2, "No privileged popup was created");
  await attention.upsert("codex", "completion-" + "a".repeat(64), { title: "Markdown fixture", description: "**Updated** content" });
  for (const window of [desktop, phone]) {
    await wait("changed markdown", () => evaluate(window, () => document.querySelector(".attention-markdown strong")?.textContent === "Updated"));
  }
  console.log("PASS attention Markdown desktop and phone smoke:", directory);
}
const watchdog = setTimeout(() => { console.error("Markdown smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); phone?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); app.exit(code); }
