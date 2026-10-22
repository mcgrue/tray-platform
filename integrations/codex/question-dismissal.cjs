// Optional local workaround for openai.chatgpt 26.1007.21434. Dry-run by default.
// This changes only question-editor state; it never sends or replays an answer.
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const VERSION = "26.1007.21434";
const MARKER = "/* tray-platform: dismiss externally answered questions v1 */";
const ORIGINAL = "if(s!=null&&s.selectedQuestionKey.entityKey===t.entityKey){let t=s.questionIds.filter(e=>n.includes(e));t.includes(s.selectedQuestionKey.itemId)?t.length!==s.questionIds.length&&RD(e,o,{...s,questionIds:t}):RD(e,o,null)}";
const REPLACEMENT = MARKER + "if(s!=null&&s.selectedQuestionKey.entityKey===t.entityKey){let t=s.questionIds.filter(r=>{if(!n.includes(r))return!1;let a=i.get(r),o=VD.resolve(e.node,e.chain,{...s.selectedQuestionKey,itemId:r}).get();return a==null||o!=null&&o.draft!==o.draftBaseline&&o.draft.trim()!==a.trim()});t.length===0?RD(e,o,null):(t.length!==s.questionIds.length||!t.includes(s.selectedQuestionKey.itemId))&&RD(e,o,{...s,questionIds:t,selectedQuestionKey:t.includes(s.selectedQuestionKey.itemId)?s.selectedQuestionKey:{...s.selectedQuestionKey,itemId:t[0]}})}";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const FOLLOW_UP_MARKER = "/* tray-platform: observe later-turn question answers v1 */";
const FOLLOW_UP_ORIGINAL = "function QLt(e,t,n){let r={hostId:t.hostId,threadId:t.threadId};return e.watch(({get:i})=>{let a=i(fs,r);if(a===`missing`){n(null);return}if(a===`ready`&&i(eRt,r)===`enabled`){i(eu,t);for(let e of i(ou,t)??[])i(tRt,{...t,itemId:e});n(Kd(e,t))}})}";
const FOLLOW_UP_REPLACEMENT = FOLLOW_UP_MARKER + function QLt(scope, identity, notify) {
  const thread = { hostId: identity.hostId, threadId: identity.threadId };
  return scope.watch(({ get }) => {
    const readiness = get(fs, thread);
    if (readiness === "missing") { notify(null); return; }
    if (readiness !== "ready" || get(eRt, thread) !== "enabled") return;
    get(eu, identity);
    for (const itemId of get(ou, identity) || []) get(tRt, { ...identity, itemId });
    const original = Kd(scope, identity);
    if (original == null) { notify(null); return; }
    const turns = get(rm, thread) || [];
    const index = turns.findIndex(turn => turn.entityKey === identity.entityKey);
    const replies = [];
    if (index >= 0) for (const turn of turns.slice(index + 1)) {
      if (turn.hostId !== identity.hostId || turn.threadId !== identity.threadId) continue;
      for (const itemId of get(ou, turn) || []) {
        const item = get(tRt, { ...turn, itemId });
        if (item?.type === "userMessage" || item?.type === "steeringUserMessage") replies.push(item);
      }
    }
    // A transient view for the question synchronizer; history remains unchanged.
    notify(replies.length ? { ...original, items: [...original.items, ...replies] } : original);
  });
}.toString();

function prepareFollowUps(source) {
  if (source.includes(FOLLOW_UP_REPLACEMENT)) return source;
  if (!source.includes(REPLACEMENT) || source.includes(FOLLOW_UP_MARKER) || source.split(FOLLOW_UP_ORIGINAL).length !== 2) {
    throw new Error("Extension question watcher differs from the verified version; no patch applied.");
  }
  return source.replace(FOLLOW_UP_ORIGINAL, FOLLOW_UP_REPLACEMENT);
}

function prepare(source) {
  if (source.includes(REPLACEMENT)) return source;
  if (source.includes(MARKER) || source.split(ORIGINAL).length !== 2) {
    throw new Error("Extension question-editor code differs from the verified version; no patch applied.");
  }
  return source.replace(ORIGINAL, REPLACEMENT);
}

function inspect(extensionRoot, { followUps = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== VERSION) {
    throw new Error("This workaround was verified only for openai.chatgpt " + VERSION);
  }
  const directory = path.join(extensionRoot, "webview", "assets");
  const matches = fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file))
    .map(file => ({ file: path.join(directory, file), source: fs.readFileSync(path.join(directory, file), "utf8") }))
    .filter(({ source }) => source.includes(ORIGINAL) || source.includes(MARKER));
  if (matches.length !== 1) throw new Error("Cannot uniquely identify the installed question editor; no patch applied.");
  const { file, source } = matches[0];
  const base = prepare(source), patched = followUps ? prepareFollowUps(base) : base;
  return { file, source, patched, originalSha256: hash(source), patchedSha256: hash(patched), changed: source !== patched };
}

function install(extensionRoot, options) {
  const patch = inspect(extensionRoot, options);
  if (!patch.changed) return { file: patch.file, alreadyApplied: true };
  const backup = patch.file + ".tray-question-dismissal-" + crypto.randomUUID() + ".bak";
  fs.writeFileSync(backup, patch.source, { flag: "wx" });
  if (fs.readFileSync(patch.file, "utf8") !== patch.source) throw new Error("Extension changed during preparation; original backup retained at " + backup);
  fs.writeFileSync(patch.file, patch.patched);
  if (hash(fs.readFileSync(patch.file, "utf8")) !== patch.patchedSha256) throw new Error("Patch verification failed; restore from " + backup);
  return { file: patch.file, backup, originalSha256: patch.originalSha256, patchedSha256: patch.patchedSha256 };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), root = args.find(arg => !arg.startsWith("--"));
    if (!root || args.some(arg => arg.startsWith("--") && !["--apply", "--follow-ups"].includes(arg))) throw new Error("Usage: node question-dismissal.cjs <extension-root> [--follow-ups] [--apply]");
    const options = { followUps: args.includes("--follow-ups") };
    if (args.includes("--apply")) console.log(JSON.stringify(install(path.resolve(root), options), null, 2));
    else {
      const { file, originalSha256, patchedSha256, changed } = inspect(path.resolve(root), options);
      console.log(JSON.stringify({ dryRun: true, file, originalSha256, patchedSha256, changed }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { prepare, prepareFollowUps, inspect, install, ORIGINAL, REPLACEMENT, FOLLOW_UP_ORIGINAL, FOLLOW_UP_REPLACEMENT };
