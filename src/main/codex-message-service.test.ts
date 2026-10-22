import { createHash } from "crypto";
import fs = require("fs");
import os = require("os");
import path = require("path");
import { AttentionItem } from "../shared/attention";
import { attentionCodexSession, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { AttentionService, validateAttentionInput } from "./attention-service";
import { CodexMessageService } from "./codex-message-service";
const { toAttention } = require("../../integrations/codex/attention-hook.cjs");

const item: AttentionItem = { source: "codex", id: "question-a", title: "Question", codexSessionId: "session-a", state: "pending", createdAt: 1, updatedAt: 1 };
function fixture(responses: any[] = [{ result: { turnId: "turn-a" } }]) {
  const client = { connect: jest.fn(async () => {}), close: jest.fn(), request: jest.fn(async (method: string, _params: any, _version: number, _owner?: string): Promise<any> => {
    if (method === "thread-owner-discovery") return { method, resultType: "success", handledByClientId: "owner-a", result: {} };
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { method, handledByClientId: "owner-a", resultType: "success", result: response };
  }) };
  return { client, service: new CodexMessageService(() => client) };
}

test("sends literal multiline Unicode input only to the discovered conversation owner", async () => {
  const { client, service } = fixture();
  const text = 'Keep café 🙂\n$(Get-Content secret); <script>literal</script>';
  expect(await service.send(item, text)).toEqual({ sessionId: "session-a", turnId: "turn-a", delivery: "steered" });
  expect(client.request.mock.calls[0]).toEqual(["thread-owner-discovery", { hostId: "local", conversationId: "session-a" }, 1]);
  expect(client.request.mock.calls[1]).toEqual(["thread-follower-steer-turn", expect.objectContaining({ conversationId: "session-a", input: [{ type: "text", text, text_elements: [] }] }), 1, "owner-a"]);
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(item.state).toBe("pending");
});

test("starts a follow-up only after explicit inactive-turn rejection, retaining settings and message identity", async () => {
  const { client, service } = fixture([{ result: { turn: { id: "new-turn" } } }]);
  const normal = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (...args) => args[0] === "thread-follower-steer-turn"
    ? { resultType: "error", error: "Cannot steer conversation session-a because its active turn already ended" } : normal(...args));
  expect(await service.send(item, "Continue")).toMatchObject({ delivery: "started", turnId: "new-turn" });
  const steer = client.request.mock.calls[1][1], start = client.request.mock.calls[2][1];
  expect(client.request.mock.calls[2][3]).toBe("owner-a");
  expect(start.turnStart.request.clientUserMessageId).toBe(steer.clientUserMessageId);
  expect(start.turnStart.context).toMatchObject({ inheritThreadSettings: true, useUserMessageAdmission: false });
  expect(start.turnStart.request.model).toBeUndefined();
  expect(start.turnStart.request.approvalPolicy).toBeUndefined();
});

test.each(["no-client-found", "request-version-mismatch", "timeout", "Codex denied the message"])("does not replay a failed send: %s", async error => {
  const { client, service } = fixture();
  client.request.mockImplementation(async () => ({ resultType: "error", error }));
  await expect(service.send(item, "hello")).rejects.toThrow();
  expect(client.request).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(1);
});

test.each([new Error("connection closed"), {}, { result: {} }])("does not retry unknown or malformed delivery", async response => {
  const { client, service } = fixture([response]);
  await expect(service.send(item, "hello")).rejects.toThrow();
  expect(client.request).toHaveBeenCalledTimes(2);
});

test.each(["timeout", "no-client-found", "request-version-mismatch", "no active turn to steer"])("never starts a follow-up for an unrecognized steer rejection: %s", async error => {
  const { client, service } = fixture();
  const normal = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (...args) => args[0] === "thread-follower-steer-turn"
    ? { resultType: "error", error } : normal(...args));
  await expect(service.send(item, "hello")).rejects.toThrow();
  expect(client.request).toHaveBeenCalledTimes(2);
});

test("rejects a response from a different owner", async () => {
  const { client, service } = fixture();
  const normal = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (...args) => {
    const response = await normal(...args);
    return args[0] === "thread-owner-discovery" ? response : { ...response, handledByClientId: "wrong" };
  });
  await expect(service.send(item, "hello")).rejects.toThrow("Unexpected Codex acknowledgement");
});

test("blocks double submission across attention items in the same session", async () => {
  const { client, service } = fixture();
  let release!: () => void;
  client.connect.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const sending = service.send(item, "hello");
  await expect(service.send({ ...item, id: "another" }, "duplicate")).rejects.toThrow("already being sent");
  release(); await sending;
});

test("rejects invalid input and non-Codex items before connecting", async () => {
  const { client, service } = fixture();
  for (const message of ["", "  ", null, "x".repeat(MAX_CODEX_MESSAGE_LENGTH + 1)]) await expect(service.send(item, message)).rejects.toThrow();
  await expect(service.send({ ...item, source: "other" }, "hello")).rejects.toThrow("no Codex session");
  await expect(service.send({ ...item, codexSessionId: undefined }, "hello")).rejects.toThrow("no Codex session");
  expect(client.connect).not.toHaveBeenCalled();
});

test("legacy header is usable only with its matching original hook identity", async () => {
  const id = "question-" + createHash("sha256").update(JSON.stringify(["session-a", "turn-a", "call-a"])).digest("hex");
  const legacy = { ...item, codexSessionId: undefined, id, description: "Project: D:\\repo\nSession: session-a\nTurn: turn-a\nCall: call-a\nTool: request_user_input_async\n\n1. Question?" };
  expect(attentionCodexSession(legacy)).toBe("session-a");
  await expect(fixture().service.send(legacy, "hello")).resolves.toMatchObject({ sessionId: "session-a" });
  await expect(fixture().service.send({ ...legacy, id: "forged" }, "hello")).rejects.toThrow("Cannot verify");
  expect(attentionCodexSession({ ...legacy, description: "Question text\nSession: wrong" })).toBeUndefined();
});

test("hook session identity survives validation, persistence, reload and human edits", async () => {
  const event = { hook_event_name: "PreToolUse", tool_name: "request_user_input_async", session_id: "session-a", turn_id: "turn-a", tool_use_id: "call-a", cwd: "D:\\repo", tool_input: { questions: [{ title: "Continue?" }] } };
  const outgoing = toAttention(event);
  expect(validateAttentionInput(outgoing.body).codexSessionId).toBe("session-a");
  expect(() => validateAttentionInput({ title: "Question", codexSessionId: "bad\nsession" })).toThrow();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tray-message-test-")), "attention.json");
  const store = new AttentionService(file); await store.initialize();
  await store.upsert(outgoing.source, outgoing.id, outgoing.body);
  await store.setState(outgoing.source, outgoing.id, "done"); store.close();
  const restored = new AttentionService(file); await restored.initialize();
  expect(restored.get(outgoing.source, outgoing.id)).toMatchObject({ codexSessionId: "session-a", state: "done" });
  restored.close();
});

test("shutdown prevents sends", async () => {
  const { service } = fixture(); service.close();
  await expect(service.send(item, "hello")).rejects.toThrow("closed");
});
