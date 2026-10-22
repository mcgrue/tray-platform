// Executes the installed extension's question synchronizer in isolation.
// No extension process, user conversation, or installed file is modified.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert").strict;
const { inspect } = require("../integrations/codex/question-dismissal.cjs");

function extract(source, name) {
  const start = source.indexOf("function " + name + "("), end = source.indexOf("}function ", start);
  assert(start >= 0 && end > start, "Missing installed extension function " + name);
  return source.slice(start, end + 1);
}

function contract(source, helpers) {
  const context = vm.createContext({
    a8t: "<send_user_message_question_reply>", o8t: "</send_user_message_question_reply>",
    c8t: { safeParse(value) {
      const data = Array.isArray(value) ? value : [value];
      return { success: data.length > 0 && data.every(reply => reply && ["questionItemId", "question", "answer"].every(key => typeof reply[key] === "string")), data };
    } },
    pt: (_state, action) => action(),
  });
  vm.runInContext([extract(helpers, "n8t"), extract(helpers, "i8t"),
    "var Eje = n8t, BAe = i8t;", ...["qv", "Jv", "Lit", "D_t", "rRt", "RD"].map(name => extract(source, name))].join("\n"), context);
  return ({ status = "accepted", answers = [[0, "Alpha"]], draft = "", count = 1, ordinary = false, unrelated = false } = {}) => {
    const scope = { hostId: "local", threadId: "fixture", entityKey: "turn:fixture" };
    const ids = Array.from({ length: count }, (_, index) => context.n8t("call_question", index));
    let selected = { selectedQuestionKey: { ...scope, itemId: ids[0], ...(unrelated && { entityKey: "turn:other" }) }, questionIds: ids };
    const drafts = new Map(ids.map((id, index) => [id, { turnId: "fixture", title: "Question " + index, draft: index ? "" : draft,
      draftBaseline: "", lastSubmission: null, isSubmitting: false, isSkipped: false }]));
    const state = { node: {}, chain: {}, set(atom, key, value) {
      if (atom === context.VD) drafts.set(key.itemId, value);
      if (atom === context.HD) selected = value(new Map([[scope.threadId, selected]])).get(scope.threadId) || null;
    } };
    context.HD = { resolve: () => ({ get: () => new Map([[scope.threadId, selected]]) }) };
    context.BD = { resolve: () => ({ get: () => ids }) };
    context.VD = { resolve: (_node, _chain, key) => ({ get: () => drafts.get(key.itemId) }) };
    const text = ordinary ? "An ordinary message" : "<send_user_message_question_reply>\n" + JSON.stringify(answers.map(([index, answer]) => ({
      questionItemId: context.n8t("call_question", index), question: "Question " + index, answer,
    }))) + "\n</send_user_message_question_reply>";
    context.rRt(state, scope, { turnId: "fixture", items: [
      { type: "agentMessage", id: "call_question", delivery: "async", questions: ids.map((_, index) => ({ title: "Question " + index })) },
      { type: "steeringUserMessage", id: "reply", status, input: [{ type: "text", text }] },
    ] });
    return { selected, drafts, ids };
  };
}

const root = process.argv[2];
assert(root, "Usage: node smoke-codex-question-dismissal.cjs <extension-root>");
const patch = inspect(root), directory = path.join(root, "webview", "assets");
const helpers = fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file))
  .map(file => fs.readFileSync(path.join(directory, file), "utf8"))
  .find(source => source.includes("function n8t(e,t){return JSON.stringify([`request_user_input_async`"));
assert(helpers, "Missing installed reply helpers");
const original = contract(patch.source, helpers), patched = contract(patch.patched, helpers);
if (patch.changed) {
  const before = original();
  assert.equal(before.drafts.get(before.ids[0]).lastSubmission, "Alpha");
  assert(before.selected, "Reproduce the original stale editor");
}
assert.equal(patched().selected, null, "Accepted external answer closes the editor");
assert(patched({ status: "pending" }).selected, "Unacknowledged answers keep the editor");
assert(patched({ status: "failed" }).selected, "Failed answers keep the editor");
assert(patched({ ordinary: true }).selected, "Ordinary messages do not close the editor");
assert(patched({ answers: [[5, "Other question"]] }).selected, "Different question identities do not close the editor");
const partial = patched({ count: 2 });
assert.deepEqual(Array.from(partial.selected.questionIds), [partial.ids[1]], "Keep the unanswered question");
assert.equal(partial.selected.selectedQuestionKey.itemId, partial.ids[1], "Select the remaining unanswered question");
assert.equal(patched({ count: 2, answers: [[0, "Alpha"], [1, "Beta"]] }).selected, null);
const dirty = patched({ draft: "Unsent local edit" });
assert(dirty.selected, "Keep unsent local edits");
assert.equal(dirty.drafts.get(dirty.ids[0]).draft, "Unsent local edit");
assert.equal(patched({ draft: " Alpha " }).selected, null, "An already delivered local draft can close");
assert(patched({ unrelated: true }).selected, "Another question editor is untouched");
console.log(JSON.stringify({ passed: true, checks: 11, reproducedOriginalBug: patch.changed, installedFilesChanged: false,
  file: patch.file, originalSha256: patch.originalSha256, patchedSha256: patch.patchedSha256 }, null, 2));
