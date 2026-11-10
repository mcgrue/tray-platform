// Run after yarn pre-build. Exercises real desktop and phone image loading.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
require("./smoke-environment.cjs");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-attention-image-smoke-"));
app.setName(`Tray Image smoke ${process.pid}`);
app.setPath("userData", directory);
process.env.TRAY_PLATFORM_USER_DATA = directory;
process.env.TRAY_PLATFORM_PORT = "0";
process.env.WATCH_MODE = "";
process.env.BREADITOR_DEV_MODE = "";
require("esbuild").buildSync({ stdin: { contents: ["attention-web", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n"), resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { createAttentionWeb, WebReceipts, WebPushService } = require(path.join(directory, "backend.cjs"));
const image = path.join(directory, "PC Config.png");
fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"));
const evaluate = (window, fn) => window.webContents.executeJavaScript(`(${fn.toString()})()`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 15000; while (Date.now() < end) { if (await predicate()) return; await sleep(50); } throw new Error("Timeout: " + label); }
let web, proxy, phone;
const sockets = new Set();
async function run() {
  const { attention, mainWindow: desktop } = await require(path.join(root, "dist/main/index.js")).applicationReady;
  await wait("desktop ready", () => evaluate(desktop, () => Boolean(document.querySelector("[data-attention-inbox]"))));
  await attention.upsert("codex", "completion-image-smoke", { title: "Codex done: fixture", description: `![Updated PC Config screen](<${image.replace(/\\/g, "/")}>)` });
  desktop.showInactive();
  await wait("desktop image", () => evaluate(desktop, () => document.querySelector(".attention-image")?.naturalWidth === 1));
  assert.deepEqual(await evaluate(desktop, () => {
    const img = document.querySelector(".attention-image");
    return { alt: img.alt, local: img.getAttribute("src").startsWith("file:///"),
      named: img.getAttribute("src").endsWith("/PC%20Config.png"), width: img.naturalWidth };
  }), { alt: "Updated PC Config screen", local: true, named: true, width: 1 });

  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  const push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: { questions: async () => [] } });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 360, height: 700, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await phone.loadURL(config.origin);
  await wait("phone image markup", () => evaluate(phone, () => Boolean(document.querySelector(".attention-image"))));
  await evaluate(phone, () => document.querySelector("[data-attention-disclosure]").click());
  phone.showInactive();
  try { await wait("phone image", () => evaluate(phone, () => document.querySelector(".attention-image")?.naturalWidth === 1)); }
  catch (error) {
    console.error("Phone image diagnostics:", await evaluate(phone, async () => {
      const img = document.querySelector(".attention-image");
      const response = await fetch(img.src);
      return { src: img.src, complete: img.complete, width: img.naturalWidth, status: response.status,
        contentType: response.headers.get("content-type"), body: response.ok ? "" : await response.text() };
    }));
    throw error;
  }
  assert.deepEqual(await evaluate(phone, () => {
    const img = document.querySelector(".attention-image");
    return { alt: img.alt, routed: img.getAttribute("src").includes("/api/attention/codex/completion-image-smoke/file?"),
      inline: img.getAttribute("src").includes("&inline=1"), overflow: document.documentElement.scrollWidth > innerWidth };
  }), { alt: "Updated PC Config screen", routed: true, inline: true, overflow: false });
  console.log("PASS attention images on desktop and phone");
}
const watchdog = setTimeout(() => { console.error("Image smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); phone?.destroy(); web?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); app.exit(code); }
