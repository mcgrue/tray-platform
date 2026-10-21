import http = require("http");
import fs = require("fs");
import os = require("os");
import path = require("path");
import { Readable } from "stream";
import { spawn } from "child_process";
import { AttentionService } from "../../src/main/attention-service";
import { createAttentionApi } from "../../src/main/attention-api";
const { run, toAttention } = require("./attention-hook.cjs");
const { parseReply } = require("./attention-answers.cjs");
const { install } = require("./install.cjs");

function question(asynchronous = true, overrides: any = {}) {
  return {
    hook_event_name: "PreToolUse", tool_name: asynchronous ? "request_user_input_async" : "request_user_input",
    session_id: "session-a", turn_id: "turn-a", tool_use_id: "call-a", cwd: "D:\\project",
    tool_input: { questions: asynchronous ? [{ title: "First choice?" }, { title: "Second choice?" }]
      : [{ id: "first", question: "First choice?" }, { id: "second", question: "Second choice?" }] },
    ...overrides,
  };
}
function reply(input: any, indices = [0, 1], overrides: any = {}) {
  return {
    hook_event_name: "UserPromptSubmit", session_id: input.session_id, turn_id: "a-later-turn",
    prompt: "<send_user_message_question_reply>\n" + JSON.stringify(indices.map(index => ({
      questionItemId: JSON.stringify([input.tool_name, input.tool_use_id, index]),
      question: input.tool_input.questions[index].title, answer: "Selected answer",
    }))) + "\n</send_user_message_question_reply>",
    ...overrides,
  };
}
function post(input: any, answers: any) {
  return { ...input, hook_event_name: "PostToolUse", tool_response: JSON.stringify({ answers }) };
}
const stream = (value: any) => Readable.from([JSON.stringify(value)]);
let service: AttentionService, server: http.Server, endpoint: string, root: string, stateDirectory: string;
let sounds: string[], failDismiss: boolean;
const invoke = (input: any) => run(stream(input), { endpoint, stateDirectory });
const state = (input: any) => service.get("codex", toAttention(input).id)?.state;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-answer-test-"));
  stateDirectory = path.join(root, "tray-platform", "question-state");
  sounds = []; failDismiss = false;
  service = new AttentionService(path.join(root, "attention.json"), { onSound: id => { sounds.push(id); } });
  await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => [] } });
  server = http.createServer((req, res) => {
    if (failDismiss && req.method === "POST") { req.resume(); res.writeHead(503); res.end(); }
    else void api(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as any).port;
});
afterEach(async () => {
  service.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("blocking answers accumulate by question ID; canceled, empty and unrelated outputs stay pending", async () => {
  const input = question(false);
  await invoke(input);
  for (const answers of [undefined, {}, { first: { answers: [] } }, { first: { answers: [""] } }, { other: { answers: ["Yes"] } }]) {
    await invoke(post(input, answers));
    expect(state(input)).toBe("pending");
  }
  await invoke(post(input, { first: { answers: ["Yes"] } }));
  expect(state(input)).toBe("pending");
  await invoke({ ...post(input, {}), tool_response: { answers: { second: { answers: ["No"] } } } });
  expect(state(input)).toBe("done");
  expect(sounds).toEqual(["icq"]);
});

test("async acceptance is not an answer; later-turn partial replies dismiss only the matching session and call", async () => {
  const input = question();
  const other = question(true, { session_id: "session-b" });
  const otherCall = question(true, { tool_use_id: "call-b" });
  for (const event of [input, other, otherCall]) await invoke(event);
  await invoke({ ...input, hook_event_name: "PostToolUse", tool_response: { accepted: true } });
  await invoke(reply(input, [0]));
  expect(state(input)).toBe("pending");
  await invoke(reply(input, [1]));
  expect(state(input)).toBe("done");
  expect(state(other)).toBe("pending");
  expect(state(otherCall)).toBe("pending");
  expect(sounds).toHaveLength(3);
});

test("wrong title, index, session and ordinary chat cannot resolve a request", async () => {
  const input = question();
  await invoke(input);
  await invoke(reply(input, [0, 1], { session_id: "wrong-session" }));
  await invoke(reply(input, [0, 1], { prompt: reply(input).prompt.replaceAll("choice?", "different?") }));
  await invoke(reply(input, [0, 1], { prompt: "The answer is Yes" }));
  await invoke(reply(input, [0, 1], { prompt: reply(input).prompt.replace(',0]', ',9]').replace(',1]', ',8]') }));
  expect(state(input)).toBe("pending");
  await invoke(reply(input));
  expect(state(input)).toBe("done");
});

test("reply parser supports singleton envelopes and rejects malformed or quoted envelopes", () => {
  const entry = { questionItemId: JSON.stringify(["request_user_input_async", "call-a", 0]), question: "Choice?", answer: "Yes" };
  const wrap = (value: any) => "<send_user_message_question_reply>" + JSON.stringify(value) + "</send_user_message_question_reply>";
  expect(parseReply(wrap(entry))).toHaveLength(1);
  expect(parseReply(wrap([entry]))).toHaveLength(1);
  for (const value of [null, {}, { ...entry, answer: "" }, { ...entry, questionItemId: "bad" },
    ...[-1, 20, 0.5, "0"].map(index => ({ ...entry, questionItemId: JSON.stringify(["request_user_input_async", "call-a", index]) })),
    { ...entry, questionItemId: JSON.stringify(["request_user_input", "call-a", 0]) }]) {
    expect(parseReply(wrap(value))).toEqual([]);
  }
  expect(parseReply("Please explain: " + wrap(entry))).toEqual([]);
  expect(parseReply("<send_user_message_question_reply>{bad}</send_user_message_question_reply>")).toEqual([]);
});

test("answered snoozed items retain human edits and history; duplicate answers preserve a manual reopen", async () => {
  const input = question();
  await invoke(input);
  const id = toAttention(input).id;
  await service.upsert("codex", id, { title: "Human title", destination: { kind: "url", url: "https://example.com" } });
  await service.setState("codex", id, "snoozed", 5);
  await invoke(reply(input));
  expect(service.get("codex", id)).toMatchObject({ state: "done", title: "Human title", destination: { url: "https://example.com" } });
  const saved = JSON.parse(fs.readFileSync(path.join(root, "attention.json"), "utf8"));
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0].state).toBe("done");
  await service.setState("codex", id, "pending");
  const reopened = service.get("codex", id);
  await invoke(reply(input)); await invoke(input);
  expect(service.get("codex", id)).toEqual(reopened);
  expect(sounds).toEqual(["icq"]);
});

test.each([false, true])("answers arriving before creation resolve silently (async=%s)", async asynchronous => {
  const input = question(asynchronous);
  await invoke(asynchronous ? reply(input) : post(input, { first: { answers: ["Yes"] }, second: { answers: ["Yes"] } }));
  expect(service.list().items).toHaveLength(0);
  await invoke(input);
  expect(state(input)).toBe("done");
  expect(sounds).toEqual([]);
});

test("failed state updates can be retried without recreating or sounding the question", async () => {
  const input = question(); await invoke(input);
  failDismiss = true;
  await expect(invoke(reply(input))).rejects.toThrow("503");
  expect(state(input)).toBe("pending");
  failDismiss = false;
  await invoke(reply(input));
  expect(state(input)).toBe("done");
  expect(sounds).toEqual(["icq"]);
});

test("ambiguous reused async call IDs do not dismiss either turn", async () => {
  const first = question(), second = question(true, { turn_id: "turn-b" });
  await invoke(first); await invoke(second); await invoke(reply(first));
  expect(state(first)).toBe("pending"); expect(state(second)).toBe("pending");
});

function cli(input: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "attention-hook.cjs")], {
      env: { ...process.env, CODEX_HOME: root, TRAY_PLATFORM_ATTENTION_URL: endpoint }, windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => { code || out || err ? reject(new Error(JSON.stringify({ code, out, err }))) : resolve(); });
    child.stdin.end(JSON.stringify(input));
  });
}

test("separate concurrent hook processes share answer state without losing partial answers or storing text", async () => {
  const input = question();
  await Promise.all([cli(reply(input, [0])), cli(reply(input, [1]))]);
  await Promise.all(Array.from({ length: 4 }, () => cli(input)));
  expect(state(input)).toBe("done");
  expect(service.list().items).toHaveLength(1); expect(sounds).toEqual([]);
  const directory = path.join(stateDirectory, fs.readdirSync(stateDirectory)[0]);
  const persisted = fs.readdirSync(directory).map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
  expect(persisted).not.toContain("Selected answer"); expect(persisted).not.toContain("First choice?");
  const second = question(true, { tool_use_id: "call-b" });
  await Promise.all([cli(second), cli(reply(second, [0])), cli(reply(second, [1]))]);
  expect(state(second)).toBe("done");
});

test("installer upgrades an existing creation hook and copies its answer module without changing other hooks", () => {
  const installed = install({ codexHome: root });
  const config = JSON.parse(fs.readFileSync(installed.hooksPath, "utf8"));
  const creation = config.hooks.PreToolUse;
  const unrelated = [{ hooks: [{ type: "command", command: "keep-existing" }] }];
  fs.writeFileSync(installed.hooksPath, JSON.stringify({ hooks: { PreToolUse: creation, Stop: unrelated } }));
  const upgraded = install({ codexHome: root });
  expect(upgraded.addedEvents).toEqual(["PostToolUse", "UserPromptSubmit"]);
  const hooks = JSON.parse(fs.readFileSync(installed.hooksPath, "utf8")).hooks;
  expect(hooks.PreToolUse).toEqual(creation); expect(hooks.Stop).toEqual(unrelated);
  expect(hooks.PostToolUse[0].matcher).toBe("^request_user_input$");
  expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
  expect(fs.readFileSync(path.join(root, "tray-platform", "attention-answers.cjs")))
    .toEqual(fs.readFileSync(path.join(__dirname, "attention-answers.cjs")));
  expect(install({ codexHome: root }).backups).toEqual([]);
});

test("installer preserves customized answer hooks and rejects invalid groups before copying files", () => {
  const installed = install({ codexHome: root });
  const config = JSON.parse(fs.readFileSync(installed.hooksPath, "utf8"));
  config.hooks.PostToolUse[0].hooks[0].timeout = 20;
  const customized = JSON.stringify(config);
  fs.writeFileSync(installed.hooksPath, customized);
  expect(() => install({ codexHome: root })).toThrow("differs");
  expect(fs.readFileSync(installed.hooksPath, "utf8")).toBe(customized);
  config.hooks.PostToolUse = "invalid";
  fs.writeFileSync(installed.hooksPath, JSON.stringify(config));
  expect(() => install({ codexHome: root })).toThrow("Invalid PostToolUse");
});
