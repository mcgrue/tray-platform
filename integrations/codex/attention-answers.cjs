// Durable correlation for command hooks running in separate processes.
// Only identifiers and question hashes are stored; answer text is not retained.
const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");

const memory = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
const requestId = (session, turn, call) => "question-" + hash(JSON.stringify([session, turn, call]));
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 256 * 1024;
const object = value => value && typeof value === "object" && !Array.isArray(value);

function stateFor(session, call, options) {
  if (!text(session) || !text(call)) throw new Error("Invalid answer identity");
  const key = hash(JSON.stringify([options.endpoint || "http://127.0.0.1:22222", session, call]));
  // Programmatic callers can use in-memory state; installed CLI hooks always
  // provide a state directory. This also keeps unit tests out of the user profile.
  if (!options.stateDirectory) {
    if (!memory.has(key)) memory.set(key, new Map());
    const files = memory.get(key);
    return {
      requests: () => [...files.entries()].filter(([name]) => name.startsWith("request-")).map(([, value]) => value),
      record: value => files.set("request-" + hash(JSON.stringify(value)), value),
      has: name => files.has(name), mark: name => files.set(name, true),
    };
  }
  const directory = path.join(options.stateDirectory, key);
  fs.mkdirSync(directory, { recursive: true });
  return {
    requests: () => fs.readdirSync(directory).filter(name => /^request-[a-f0-9]{64}\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))),
    record: value => {
      const bytes = JSON.stringify(value);
      const file = path.join(directory, "request-" + hash(bytes) + ".json");
      if (fs.existsSync(file)) return;
      const temporary = path.join(directory, "writing-" + randomUUID());
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      // The content-addressed target has identical bytes if another process won.
      // Readers only see complete JSON; concurrent answer markers never overwrite.
      fs.renameSync(temporary, file);
    },
    has: name => fs.existsSync(path.join(directory, name)),
    mark: name => fs.closeSync(fs.openSync(path.join(directory, name), "a")),
  };
}

function rememberRequest(event, options) {
  const { session_id: session, turn_id: turn, tool_use_id: call, tool_name: tool } = event;
  if (![session, turn, call].every(text) || !["request_user_input", "request_user_input_async"].includes(tool)) {
    throw new Error("Invalid question identity");
  }
  const questions = event.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 20) throw new Error("Invalid questions");
  const request = {
    version: 1, session, turn, call, tool, id: requestId(session, turn, call),
    questions: questions.map(question => {
      const title = tool === "request_user_input_async" ? question?.title : question?.question;
      if (!text(title)) throw new Error("Invalid question");
      return { hash: hash(title), id: text(question.id) ? question.id : null };
    }),
  };
  stateFor(session, call, options).record(request);
  return request;
}

const marker = (request, index) => (request.tool === "request_user_input_async" ? "async" : request.id) +
  "-answer-" + index + "-" + request.questions[index].hash;

function isAnswered(request, options) {
  const state = stateFor(request.session, request.call, options);
  // Async replies lack the original turn. Fail closed if a call ID was reused.
  if (request.tool === "request_user_input_async" && state.requests().length !== 1) return false;
  return request.questions.every((_, index) => state.has(marker(request, index)));
}

async function resolveAnswered(request, options, dismiss) {
  const state = stateFor(request.session, request.call, options);
  const resolved = "resolved-" + request.id;
  if (state.has(resolved) || !isAnswered(request, options)) return false;
  if (!await dismiss({ source: "codex", id: request.id }, options)) return false;
  state.mark(resolved);
  return true;
}

function parseReply(prompt) {
  if (typeof prompt !== "string") return [];
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(prompt);
  if (!match) return [];
  let replies;
  try { replies = JSON.parse(match[1]); } catch { return []; }
  if (!Array.isArray(replies)) replies = [replies];
  if (replies.length < 1 || replies.length > 100) return [];
  return replies.flatMap(reply => {
    if (!object(reply) || !text(reply.questionItemId) || !text(reply.question) || !text(reply.answer)) return [];
    let identity;
    try { identity = JSON.parse(reply.questionItemId); } catch { return []; }
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== "request_user_input_async" ||
        !text(identity[1]) || !Number.isInteger(identity[2]) || identity[2] < 0 || identity[2] >= 20) return [];
    return [{ call: identity[1], index: identity[2], hash: hash(reply.question) }];
  });
}

async function handleAnswers(event, options, dismiss) {
  if (event?.hook_event_name === "PostToolUse" && event.tool_name === "request_user_input") {
    let response = event.tool_response;
    if (typeof response === "string") { try { response = JSON.parse(response); } catch { return { ignored: true }; } }
    if (!object(response?.answers)) return { ignored: true };
    const request = rememberRequest(event, options);
    const state = stateFor(request.session, request.call, options);
    request.questions.forEach((question, index) => {
      if (!question.id || !Object.prototype.hasOwnProperty.call(response.answers, question.id)) return;
      const answers = response.answers[question.id]?.answers;
      if (Array.isArray(answers) && answers.length > 0 && answers.every(text)) state.mark(marker(request, index));
    });
    return { dismissed: await resolveAnswered(request, options, dismiss) };
  }
  if (event?.hook_event_name !== "UserPromptSubmit") return { ignored: true };
  const replies = parseReply(event.prompt);
  if (!replies.length) return { ignored: true };
  const states = new Map();
  for (const reply of replies) {
    const state = stateFor(event.session_id, reply.call, options);
    state.mark("async-answer-" + reply.index + "-" + reply.hash);
    states.set(reply.call, state);
  }
  let dismissed = 0;
  for (const state of states.values()) {
    for (const request of state.requests()) {
      if (request.tool === "request_user_input_async" && await resolveAnswered(request, options, dismiss)) dismissed++;
    }
  }
  return { dismissed };
}

module.exports = { requestId, rememberRequest, isAnswered, resolveAnswered, handleAnswers, parseReply };
