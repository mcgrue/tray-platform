#!/usr/bin/env node
// Standalone Codex command hook. No Electron runtime or npm dependencies needed.
const http = require("http");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { requestId, rememberRequest, isAnswered, resolveAnswered, handleAnswers } = require("./attention-answers.cjs");
const { rememberCompletion, isAcknowledged, resolveCompletion, acknowledgeCompletions } = require("./attention-completion-dismissal.cjs");

const ENDPOINT = "http://127.0.0.1:22222";
const TIMEOUT_MS = 1500;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MATCHER = "^request_user_input(_async)?$";

function required(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_INPUT_BYTES) throw new Error("Invalid " + name);
  return value;
}

function shorten(value, limit) {
  if (value.length <= limit) return value;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end) + "…";
}

function toAttention(event) {
  if (event?.hook_event_name === "Stop") return completionAttention(event);
  if (event?.hook_event_name !== "PreToolUse" || !new RegExp(MATCHER).test(event.tool_name)) return null;
  const session = required(event.session_id, "session_id");
  const turn = required(event.turn_id, "turn_id");
  const call = required(event.tool_use_id, "tool_use_id");
  const cwd = required(event.cwd, "cwd");
  const questions = event.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 20) throw new Error("Invalid questions");
  const asynchronous = event.tool_name === "request_user_input_async";
  const rendered = questions.map((question, index) => {
    const title = required(asynchronous ? question?.title : question?.question, "question");
    const options = question.options;
    if (options !== undefined && (!Array.isArray(options) || options.length > 50)) throw new Error("Invalid options");
    const choices = (options || []).map(option => {
      const label = required(asynchronous ? option : option?.label, "option");
      const description = !asynchronous && typeof option.description === "string" ? ": " + option.description : "";
      return "- " + label + description;
    });
    return { title, text: [(index + 1) + ". " + title, ...choices].join("\n") };
  });
  const id = requestId(session, turn, call);
  return {
    source: "codex",
    id,
    body: {
      title: shorten(rendered[0].title, 500),
      ...(/^[a-zA-Z0-9_-]{1,200}$/.test(session) && { codexSessionId: session }),
      project: shorten(cwd, 500),
      description: shorten([
        "Project: " + cwd, "Session: " + session, "Turn: " + turn, "Call: " + call,
        "Tool: " + event.tool_name, "", ...rendered.map(question => question.text),
      ].join("\n"), 12000),
      sound: "icq",
    },
  };
}

function completionAttention(event) {
  // Codex explicitly sends null for ephemeral turns, including the desktop
  // app's internal suggestion jobs. They have no saved conversation to resume.
  // Preserve older/manual producers that omit transcript_path altogether.
  if (event.transcript_path === null) return null;
  const session = required(event.session_id, "session_id");
  const turn = required(event.turn_id, "turn_id");
  const cwd = required(event.cwd, "cwd");
  const message = event.last_assistant_message;
  if (message != null && typeof message !== "string") throw new Error("Invalid last_assistant_message");
  const projectName = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
  return {
    source: "codex",
    id: "completion-" + createHash("sha256").update(JSON.stringify([session, turn])).digest("hex"),
    body: {
      title: shorten("Codex done: " + projectName, 500),
      ...(/^[a-zA-Z0-9_-]{1,200}$/.test(session) && { codexSessionId: session }),
      project: shorten(cwd, 500),
      description: shorten(message?.trim() || "Codex finished this turn.", 12000),
      sound: "icq",
    },
  };
}

function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Attention endpoint must be an HTTP loopback origin");
  }
  return url;
}

function deliver(item, { endpoint = ENDPOINT, timeoutMs = TIMEOUT_MS } = {}) {
  return request(item, { endpoint, timeoutMs });
}

function dismiss(item, options = {}) {
  return request(item, { ...options, dismiss: true });
}

function request(item, { endpoint = ENDPOINT, timeoutMs = TIMEOUT_MS, dismiss: resolving = false, list = false } = {}) {
  const url = new URL(list ? "/api/attention" : "/api/attention/" + encodeURIComponent(item.source) + "/" + encodeURIComponent(item.id) +
    (resolving ? "/state" : ""), localEndpoint(endpoint));
  const body = list ? undefined : JSON.stringify(resolving ? { state: "done" } : item.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const req = http.request(url, {
      method: list ? "GET" : resolving ? "POST" : "PUT",
      headers: list ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...(!resolving && { "If-None-Match": "*" }) },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > (list ? 8 * 1024 * 1024 : MAX_RESPONSE_BYTES)) req.destroy(new Error("Attention response too large"));
        else chunks.push(chunk);
      });
      res.on("error", error => finish(error));
      res.on("aborted", () => finish(new Error("Attention response aborted")));
      res.on("end", () => {
        try {
          // Already delivered: preserve all human edits and the item's disposition.
          if (!resolving && !list && res.statusCode === 412) { finish(null, null); return; }
          // The answer hook can beat the background creation hook. The durable
          // answer marker lets creation finish the dismissal after its PUT.
          if (resolving && res.statusCode === 404) { finish(null, false); return; }
          if (res.statusCode !== 200) throw new Error("Attention HTTP " + res.statusCode);
          let response;
          try { response = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { throw new Error("Invalid attention response JSON"); }
          if (list) {
            if (!Array.isArray(response?.items) || response.error) throw new Error("Unexpected attention snapshot");
            finish(null, response.items);
          } else if (resolving) {
            if (response?.ok !== true) throw new Error("Unexpected attention response");
            finish(null, true);
          } else {
            if (response?.item?.source !== item.source || response?.item?.id !== item.id) throw new Error("Unexpected attention response");
            finish(null, response.item);
          }
        } catch (error) { finish(error); }
      });
    });
    // Absolute deadline also bounds slow/dribbling responses.
    const timer = setTimeout(() => req.destroy(new Error("Attention request timed out")), timeoutMs);
    req.on("error", error => finish(error));
    req.end(body);
  });
}

function readInput(input, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.pause();
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) finish(new Error("Hook input too large"));
      else chunks.push(buffer);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(new Error("Invalid hook JSON")); }
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error("Hook input timed out")), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function run(input = process.stdin, options = {}) {
  const observedAt = Date.now();
  const event = await readInput(input, options.timeoutMs);
  const item = toAttention(event);
  if (!item) {
    if (event?.hook_event_name !== "UserPromptSubmit") return handleAnswers(event, options, dismiss);
    // Failure in completion acknowledgement must not prevent question answers.
    const results = await Promise.allSettled([
      handleAnswers(event, options, dismiss),
      acknowledgeCompletions(event, options, config => request(null, { ...config, list: true }), dismiss, observedAt),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    return results[1].value ? { ...results[0].value, completionsDismissed: results[1].value } : results[0].value;
  }
  // Keep this process alive until the server has captured its Codex ancestry.
  // observedAt prevents a subsequently recycled hook PID from being accepted.
  if (options.captureOrigin) item.body.originProcess = { pid: process.pid, observedAt: Date.now() };
  if (event.hook_event_name === "Stop") {
    const record = rememberCompletion(event, item, options, observedAt);
    const outgoing = isAcknowledged(record) ? { ...item, body: { ...item.body, sound: undefined } } : item;
    await deliver(outgoing, options);
    await resolveCompletion(record, options, dismiss);
    return { source: item.source, id: item.id };
  }
  const correlation = rememberRequest(event, options);
  const outgoing = isAnswered(correlation, options) ? { ...item, body: { ...item.body, sound: undefined } } : item;
  await deliver(outgoing, options);
  await resolveAnswered(correlation, options, dismiss);
  return { source: item.source, id: item.id };
}

if (require.main === module) {
  run(process.stdin, {
    captureOrigin: process.platform === "win32",
    timeoutMs: process.platform === "win32" ? 3500 : TIMEOUT_MS,
    endpoint: process.env.TRAY_PLATFORM_ATTENTION_URL || ENDPOINT,
    stateDirectory: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "tray-platform", "question-state"),
    completionStateDirectory: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "tray-platform", "completion-state"),
  })
    .catch(error => {
      // A missing tray process must not affect the agent or reveal question text in logs.
      const code = typeof error.code === "string" ? error.code : error.message;
      process.stderr.write("[tray-platform] Notification not delivered: " + code + "\n");
    })
    .finally(() => { process.exitCode = 0; });
}

module.exports = { toAttention, deliver, dismiss, readInput, run, MATCHER, ENDPOINT, MAX_INPUT_BYTES };
