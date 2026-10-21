#!/usr/bin/env node
// Standalone Codex command hook. No Electron runtime or npm dependencies needed.
const http = require("http");
const { createHash } = require("crypto");

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
  const id = "question-" + createHash("sha256").update(JSON.stringify([session, turn, call])).digest("hex");
  return {
    source: "codex",
    id,
    body: {
      title: shorten("Codex needs input: " + rendered[0].title, 500),
      project: shorten(cwd, 500),
      description: shorten([
        "Project: " + cwd, "Session: " + session, "Turn: " + turn, "Call: " + call,
        "Tool: " + event.tool_name, "", ...rendered.map(question => question.text),
      ].join("\n"), 12000),
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
  const url = new URL("/api/attention/" + item.source + "/" + item.id, localEndpoint(endpoint));
  const body = JSON.stringify(item.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const req = http.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "If-None-Match": "*" },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("Attention response too large"));
        else chunks.push(chunk);
      });
      res.on("error", error => finish(error));
      res.on("aborted", () => finish(new Error("Attention response aborted")));
      res.on("end", () => {
        try {
          // Already delivered: preserve all human edits and the item's disposition.
          if (res.statusCode === 412) { finish(null, null); return; }
          if (res.statusCode !== 200) throw new Error("Attention HTTP " + res.statusCode);
          let response;
          try { response = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { throw new Error("Invalid attention response JSON"); }
          if (response?.item?.source !== item.source || response?.item?.id !== item.id) throw new Error("Unexpected attention response");
          finish(null, response.item);
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
  const event = await readInput(input, options.timeoutMs);
  const item = toAttention(event);
  if (!item) return { ignored: true };
  await deliver(item, options);
  return { source: item.source, id: item.id };
}

if (require.main === module) {
  run(process.stdin, { endpoint: process.env.TRAY_PLATFORM_ATTENTION_URL || ENDPOINT })
    .catch(error => {
      // A missing tray process must not affect the agent or reveal question text in logs.
      const code = typeof error.code === "string" ? error.code : error.message;
      process.stderr.write("[tray-platform] Notification not delivered: " + code + "\n");
    })
    .finally(() => { process.exitCode = 0; });
}

module.exports = { toAttention, deliver, readInput, run, MATCHER, ENDPOINT, MAX_INPUT_BYTES };
