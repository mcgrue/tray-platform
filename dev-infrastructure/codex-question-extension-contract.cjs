// Executes the installed extension's pure pending-question reducer. No VS Code
// process is controlled. Its parser's schema dependency is represented by the
// same three-string-field contract; the parser and reducer bodies are unmodified.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert").strict;
const { createHash } = require("crypto");

function loadQuestionContract(extensionRoot) {
  const directory = path.join(extensionRoot, "webview", "assets");
  const files = fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file));
  const find = marker => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(directory, file), "utf8");
      if (source.includes(marker)) return { file, source };
    }
    throw new Error("Installed extension question contract changed: " + marker);
  };
  // Minified names are reused across bundles; identify the question reducer by its guard.
  const helpers = find("function n8t("), reducer = find("function Axn(e,t){if(e?.status!==");
  const extract = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    assert(start >= 0, "Missing extension function " + name);
    const end = source.indexOf("}function ", start);
    assert(end > start, "Cannot locate extension function boundary " + name);
    return source.slice(start, end + 1);
  };
  const context = vm.createContext({
    a8t: "<send_user_message_question_reply>", o8t: "</send_user_message_question_reply>",
    c8t: { safeParse(value) {
      const data = Array.isArray(value) ? value : [value];
      return { success: data.length > 0 && data.every(reply => reply && ["questionItemId", "question", "answer"].every(key => typeof reply[key] === "string")), data };
    } },
  });
  vm.runInContext([...["n8t", "i8t"].map(name => extract(helpers.source, name)),
    ...["Axn", "Nxn", "Pxn", "Fxn", "Ixn", "Lxn", "Rxn", "zxn"].map(name => extract(reducer.source, name)),
    "var Re = n8t, Ne = i8t;"].join("\n"), context);
  return {
    evidence: [helpers, reducer].map(({ file, source }) => ({ file, sha256: createHash("sha256").update(source).digest("hex") })),
    pending(call, questions, text, steeringStatus) {
      const message = steeringStatus === undefined ? { type: "userMessage", content: [{ type: "text", text }] }
        : { type: "steeringUserMessage", status: steeringStatus, input: [{ type: "text", text }] };
      return context.Axn({ status: "inProgress", turnId: "fixture-turn", items: [{ type: "agentMessage", id: call, questions }, message] }, null)?.questionIds || [];
    },
  };
}
module.exports = { loadQuestionContract };
