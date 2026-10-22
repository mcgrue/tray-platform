// Executes the installed question watcher and synchronizer with separate turns.
// No live conversation or installed extension asset is modified.
const assert = require("assert").strict;
const fs = require("fs"), path = require("path"), vm = require("vm"), ts = require("typescript");
const { inspect, FOLLOW_UP_ORIGINAL, FOLLOW_UP_REPLACEMENT } = require("../integrations/codex/question-dismissal.cjs");

function functions(source, names) {
  const file = ts.createSourceFile("extension.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return names.map(name => {
    const matches = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, "Unique installed function " + name);
    return matches[0].getText(file);
  }).join("\n");
}

function contract(source, helpers) {
  const bodies = functions(source, ["QLt", "qv", "Jv", "Lit", "D_t", "rRt", "RD"]);
  return ({ count = 1, draft = "", unrelated = false } = {}) => {
    const context = vm.createContext({
      a8t: "<send_user_message_question_reply>", o8t: "</send_user_message_question_reply>",
      c8t: { safeParse(value) {
        const data = Array.isArray(value) ? value : [value];
        return { success: data.length > 0 && data.every(reply => reply && ["questionItemId", "question", "answer"].every(key => typeof reply[key] === "string")), data };
      } },
      pt: (_state, action) => action(), fs: "ready", eRt: "enabled", eu: "turn", ou: "items", tRt: "item", rm: "turns",
    });
    vm.runInContext(helpers + "\nvar Eje=n8t,BAe=i8t;\n" + bodies, context);
    const scope = { hostId: "local", threadId: "fixture", entityKey: "turn:question" };
    const ids = Array.from({ length: count }, (_, i) => context.n8t("call_question", i));
    const original = { turnId: "question", items: [{ type: "agentMessage", id: "call_question", delivery: "async",
      questions: ids.map((_, i) => ({ title: "Question " + i })) }] };
    const originalBytes = JSON.stringify(original);
    let selected = { selectedQuestionKey: { ...scope, ...(unrelated && { entityKey: "turn:other" }), itemId: ids[0] }, questionIds: ids };
    const drafts = new Map(ids.map((id, i) => [id, { turnId: "question", title: "Question " + i, draft: i ? "" : draft,
      draftBaseline: "", lastSubmission: null, isSubmitting: false, isSkipped: false }]));
    const turns = [scope], values = new Map([[scope.entityKey, original]]), subscriptions = [];
    const key = (atom, identity) => [atom, identity.hostId, identity.threadId, identity.entityKey, identity.itemId].join("|");
    const state = { node: {}, chain: {},
      watch(callback) {
        const entry = { dependencies: new Set(), run() {
          entry.dependencies.clear();
          callback({ get(atom, identity) {
            entry.dependencies.add(key(atom, identity));
            if (atom === "ready") return "ready";
            if (atom === "enabled") return "enabled";
            if (atom === "turns") return turns;
            const turn = values.get(identity.entityKey);
            if (atom === "turn") return turn;
            if (atom === "items") return turn?.items.map(item => item.id);
            if (atom === "item") return turn?.items.find(item => item.id === identity.itemId);
            throw new Error("Unexpected watcher dependency " + atom);
          } });
        } };
        subscriptions.push(entry); entry.run(); return () => subscriptions.splice(subscriptions.indexOf(entry), 1);
      },
      set(atom, identity, value) {
        if (atom === context.VD) drafts.set(identity.itemId, value);
        if (atom === context.HD) selected = value(new Map([[scope.threadId, selected]])).get(scope.threadId) || null;
      },
    };
    const emit = (atom, identity) => subscriptions.filter(entry => entry.dependencies.has(key(atom, identity))).forEach(entry => entry.run());
    context.Kd = (_state, identity) => values.get(identity.entityKey);
    context.HD = { resolve: () => ({ get: () => new Map([[scope.threadId, selected]]) }) };
    context.BD = { resolve: () => ({ get: () => ids }) };
    context.VD = { resolve: (_node, _chain, identity) => ({ get: () => drafts.get(identity.itemId) }) };
    context.QLt(state, scope, turn => { if (turn) context.rRt(state, scope, turn); });
    let next = 0;
    return {
      get selected() { return selected; }, drafts, ids,
      unchanged() { assert.equal(JSON.stringify(original), originalBytes, "Original turn history is unchanged"); },
      reply({ status, answers = [[0, "Alpha"]], ordinary = false, foreign = false, earlier = false, sameTurn = false } = {}) {
        const text = ordinary ? "Ordinary follow-up" : "<send_user_message_question_reply>\n" + JSON.stringify(answers.map(([index, answer]) => ({
          questionItemId: context.n8t("call_question", index), question: "Question " + index, answer,
        }))) + "\n</send_user_message_question_reply>";
        const id = "reply-" + ++next;
        let item = status === undefined ? { id, type: "userMessage", content: [{ type: "text", text }] }
          : { id, type: "steeringUserMessage", status, input: [{ type: "text", text }] };
        const identity = sameTurn ? scope : { ...scope, entityKey: "turn:" + id, ...(foreign && { threadId: "other" }) };
        const turn = sameTurn ? original : { turnId: id, items: [] };
        turn.items.push(item); values.set(identity.entityKey, turn);
        if (sameTurn) emit("items", scope);
        else { earlier ? turns.unshift(identity) : turns.push(identity); }
        // Thread-level keys omit the turn identity, matching the real watcher.
        if (!sameTurn) emit("turns", { hostId: scope.hostId, threadId: scope.threadId });
        return status => {
          item = { ...item, status }; turn.items[turn.items.length - 1] = item;
          emit("item", { ...identity, itemId: id });
        };
      },
    };
  };
}

const root = process.argv[2];
assert(root, "Usage: node smoke-codex-question-follow-ups.cjs <extension-root>");
const patch = inspect(root, { followUps: true }), directory = path.join(root, "webview", "assets");
const helperSource = fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file))
  .map(file => fs.readFileSync(path.join(directory, file), "utf8"))
  .find(source => source.includes("function n8t(e,t){return JSON.stringify([`request_user_input_async`"));
assert(helperSource, "Installed question parser is unavailable");
const helpers = functions(helperSource, ["n8t", "i8t"]);
const previous = contract(patch.source.replace(FOLLOW_UP_REPLACEMENT, FOLLOW_UP_ORIGINAL), helpers);
const fixed = contract(patch.patched, helpers);
const before = previous(); before.reply();
assert(before.selected, "Reproduce the still-open dialog after a later-turn reply");
assert.equal(before.drafts.get(before.ids[0]).lastSubmission, null, "Previous watcher misses the reply");
const after = fixed(); after.reply();
assert.equal(after.selected, null, "Later-turn answer dismisses the dialog");
assert.equal(after.drafts.get(after.ids[0]).lastSubmission, "Alpha"); after.unchanged();
const pending = fixed(), accept = pending.reply({ status: "pending" });
assert(pending.selected); accept("accepted"); assert.equal(pending.selected, null, "Acceptance triggers the watcher");
for (const options of [{ status: "failed" }, { ordinary: true }, { answers: [[5, "Other"]] }, { foreign: true }, { earlier: true }]) {
  const scenario = fixed(); scenario.reply(options); assert(scenario.selected, JSON.stringify(options)); scenario.unchanged();
}
const same = fixed(); same.reply({ status: "accepted", sameTurn: true }); assert.equal(same.selected, null);
const partial = fixed({ count: 2 }); partial.reply();
assert.deepEqual(Array.from(partial.selected.questionIds), [partial.ids[1]]);
assert.equal(partial.selected.selectedQuestionKey.itemId, partial.ids[1]);
partial.reply({ answers: [[1, "Beta"]] }); assert.equal(partial.selected, null);
const dirty = fixed({ draft: "Unsent local draft" }); dirty.reply();
assert(dirty.selected); assert.equal(dirty.drafts.get(dirty.ids[0]).draft, "Unsent local draft");
const matching = fixed({ draft: " Alpha " }); matching.reply(); assert.equal(matching.selected, null);
const unrelated = fixed({ unrelated: true }); unrelated.reply(); assert(unrelated.selected);
console.log(JSON.stringify({ passed: true, reproducedPreviousBug: true, installedFilesChanged: false,
  checks: ["separate question and reply turns", "subscription on new turns", "pending-to-accepted notification", "same-turn answers", "partial answers across turns", "draft preservation", "unrelated and foreign questions", "original history unchanged"],
  file: patch.file, originalSha256: patch.originalSha256, patchedSha256: patch.patchedSha256 }, null, 2));
