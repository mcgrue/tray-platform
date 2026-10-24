// Real phone-sized Chromium preview served through the authenticated file route.
const assert = require("assert").strict, fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { app, BrowserWindow } = require("electron");
require("./smoke-environment.cjs");
const root = path.join(__dirname, ".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "tray-highlight-smoke-"));
console.log("Syntax highlighting evidence:", directory);
app.setName(`Tray syntax smoke ${process.pid}`); app.setPath("userData", directory);
require("esbuild").buildSync({ stdin: { contents: ["attention-service", "attention-web", "web-receipts", "web-push-service"].map(name => `export * from './src/main/${name}';`).join("\n") +
  "\nexport { attentionFileHref } from './src/shared/attention-link';", resolveDir: root },
  outfile: path.join(directory, "backend.cjs"), bundle: true, platform: "node", target: "node16" });
const { AttentionService, createAttentionWeb, WebReceipts, WebPushService, attentionFileHref } = require(path.join(directory, "backend.cjs"));
const source = ['export interface PreviewOptions {', '  count: number;', '}', '/* A multiline comment',
  '   stays colored on both lines. */', 'export function makeGreeting(options: PreviewOptions): string {',
  '  const message = `Hello', 'from the PC`;', '  return message + " ".repeat(options.count);', '}', '',
  'const html = "<script>window.pwned = true</script>";', 'const longLine = "' + "wrap me ".repeat(20) + '";', ''].join("\r\n");
const filename = path.join(directory, "Preview demo.ts"); fs.writeFileSync(filename, source);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 10000; while (Date.now() < end) { if (await predicate()) return; await sleep(40); } throw new Error("Timeout: " + label); }
let attention, push, web, proxy, phone;
const sockets = new Set();
async function run() {
  await app.whenReady();
  attention = new AttentionService(path.join(directory, "attention.json")); await attention.initialize();
  const item = await attention.upsert("demo", "syntax", { title: "Syntax highlighting", description: `[source](<${filename}:4>)` });
  const config = { origin: "", port: 0, allowedUsers: ["fixture"] };
  const receipts = new WebReceipts(path.join(directory, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(directory, "push.json"), "https://fixture.ts.net", async () => {}, ["fixture"]); await push.initialize(attention.list());
  web = createAttentionWeb({ config, attention, receipts, push, assets: path.join(root, "dist/web"), operations: {} });
  await new Promise(resolve => web.server.listen(0, "127.0.0.1", resolve));
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: web.server.address().port, path: req.url, method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "fixture" } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); config.origin = `http://127.0.0.1:${proxy.address().port}`;
  phone = new BrowserWindow({ width: 360, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await phone.loadURL(config.origin + attentionFileHref(item, filename + ":4"));
  phone.webContents.debugger.attach("1.3");
  const command = (method, params) => phone.webContents.debugger.sendCommand(method, params);
  await command("DOM.enable"); await command("CSS.enable");
  const { root: document } = await command("DOM.getDocument");
  const query = async selector => (await command("DOM.querySelector", { nodeId: document.nodeId, selector })).nodeId;
  const color = async (selector, property = "color") => {
    const nodeId = await query(selector); assert(nodeId, selector);
    return (await command("CSS.getComputedStyleForNode", { nodeId })).computedStyle.find(style => style.name === property).value;
  };
  assert.equal(await color(".hljs-keyword"), "rgb(196, 181, 253)");
  assert.equal(await color(".hljs-string"), "rgb(167, 243, 208)");
  assert.equal(await color("#L5 .hljs-comment"), "rgb(148, 163, 184)");
  assert.equal(await color("#L8 .hljs-string"), "rgb(167, 243, 208)");
  assert.equal(await color("#L4", "background-color"), "rgb(57, 70, 104)");
  const { outerHTML } = await command("DOM.getOuterHTML", { nodeId: await query("pre") });
  const text = outerHTML.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|#x27);/g,
    (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }[entity]));
  assert.equal(text, source.replace(/\r\n/g, "\n"));
  assert.equal(await query("script"), 0); assert.equal(await query("img"), 0);
  const layout = await command("Page.getLayoutMetrics");
  assert(layout.cssContentSize.width <= layout.cssLayoutViewport.clientWidth, "Source wraps within phone viewport");
  const original = await new Promise((resolve, reject) => {
    http.get(config.origin + attentionFileHref(item, filename + ":4").split("#")[0] + "&download=1", response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ headers: response.headers, bytes: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  assert.equal(original.bytes.toString(), source); assert(original.headers["content-disposition"].startsWith("attachment;"));
  let downloaded;
  phone.webContents.session.once("will-download", (event, item) => { downloaded = item.getFilename(); event.preventDefault(); });
  const { model } = await command("DOM.getBoxModel", { nodeId: await query("a[download]") });
  const x = (model.content[0] + model.content[2]) / 2, y = (model.content[1] + model.content[5]) / 2;
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await wait("download click", () => downloaded); assert.equal(downloaded, path.basename(filename));
  phone.showInactive(); await sleep(150);
  fs.writeFileSync(path.join(directory, "phone-source-preview.png"), (await phone.webContents.capturePage()).toPNG());
  console.log("PASS phone syntax colors, multiline tokens, line target, narrow layout, inert source and original download:", directory);
}
const watchdog = setTimeout(() => { console.error("Syntax smoke timed out"); app.exit(1); }, 60000);
run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) { clearTimeout(watchdog); phone?.destroy(); web?.close(); attention?.close(); push?.close(); for (const socket of sockets) socket.destroy(); proxy?.close(); app.exit(code); }
