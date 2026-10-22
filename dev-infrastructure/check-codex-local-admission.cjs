// Set CODEX_EXTENSION_ROOT to the installed openai.chatgpt extension directory.
// Executes its admission predicate and local transport rejection in isolation.
// Does not control VS Code or send messages to existing conversations.
const assert = require("assert").strict;
const fs = require("fs"), path = require("path"), vm = require("vm");
const { createHash } = require("crypto");
const { buildSync } = require("esbuild");

async function run() {
  assert(process.env.CODEX_EXTENSION_ROOT, "Set CODEX_EXTENSION_ROOT");
  const directory = path.join(process.env.CODEX_EXTENSION_ROOT, "webview", "assets");
  const files = fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file));
  const find = marker => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(directory, file), "utf8");
      if (source.includes(marker)) return { file, source };
    }
    throw new Error("Installed extension admission contract changed: " + marker);
  };
  const predicate = find("function D1(e,t,n,r=!1)"), transport = find("User-message admission requires a cloud app-server host");
  const extract = (source, marker) => {
    const start = source.indexOf(marker), end = source.indexOf("}function ", start);
    assert(start >= 0 && end > start, "Cannot extract " + marker);
    return source.slice(start, end + 1);
  };
  // These aliases and the durable host ID are verified against the installed bundle.
  assert(predicate.source.includes("IZt as te") && predicate.source.includes("TQt as z"));
  assert(transport.source.includes("yy as IZt") && transport.source.includes("dyt as TQt"));
  const host = /\bby=(`[^`]+`)/.exec(transport.source);
  assert(host, "Cannot locate the extension's durable host ID");
  const context = vm.createContext({});
  vm.runInContext([
    `var by = ${host[1]};`,
    extract(transport.source, "function yy("), extract(transport.source, "function dyt("),
    "var te = yy, z = dyt;",
    ...["SQ", "akn", "D1"].map(name => extract(predicate.source, `function ${name}(`)),
  ].join("\n"), context);
  const localMethod = /async sendAppServerExtensionRequest\(e,t,n\)\{[^}]+\}/.exec(transport.source);
  assert(localMethod, "Cannot locate the local transport rejection");
  const local = vm.runInContext(`({ dispatchMessage() {}, ${localMethod[0]} })`, context);
  const conversation = { mode: "default", threadStartKind: "default", threadSource: "user" };
  const request = { clientUserMessageId: "fixture-message", input: [{ type: "text", text: "Test reply" }] };
  assert.equal(context.D1("local", conversation, request, true), true, "Old flag selects admission");
  await assert.rejects(local.sendAppServerExtensionRequest("turn/addUserMessage", request),
    /User-message admission requires a cloud app-server host/);
  assert.equal(context.D1("local", conversation, request, false), false);

  const built = buildSync({ entryPoints: [path.join(__dirname, "../src/main/codex-message-service.ts")],
    bundle: true, platform: "node", format: "cjs", write: false });
  const serviceModule = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module: serviceModule, exports: serviceModule.exports, require });
  let starts = 0;
  const service = new serviceModule.exports.CodexMessageService(() => ({
    async connect() {}, close() {},
    async request(method, params) {
      if (method === "thread-follower-steer-turn") return { resultType: "error", error: "Cannot steer conversation local-session because its active turn already ended" };
      if (method === "thread-follower-start-turn") {
        if (context.D1("local", conversation, params.turnStart.request, params.turnStart.context?.useUserMessageAdmission)) {
          await local.sendAppServerExtensionRequest("turn/addUserMessage", params.turnStart.request);
        }
        starts++;
      }
      return { method, resultType: "success", handledByClientId: "local-owner", result: { result: { turn: { id: "local-turn" } } } };
    },
  }));
  const receipt = await service.send({ source: "codex", codexSessionId: "local-session" }, "Test reply");
  assert.equal(receipt.delivery, "started"); assert.equal(starts, 1);
  console.log(JSON.stringify({ passed: true, checks: ["old flag reproduces installed transport error", "fixed service avoids installed admission branch"],
    extensionContract: [predicate, transport].map(({ file, source }) => ({ file, sha256: createHash("sha256").update(source).digest("hex") })) }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
