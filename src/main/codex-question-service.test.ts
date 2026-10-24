import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { AttentionItem } from "../shared/attention";
import { CodexMessageReceipt } from "../shared/codex-message";
import { hasCodexAsyncQuestion, parseQuestionReplies, questionReplyId } from "../shared/codex-question";
import { CodexQuestionService } from "./codex-question-service";

const session = "session-a", turn = "turn-a", call = "call-a";
const id = "question-" + createHash("sha256").update(JSON.stringify([session, turn, call])).digest("hex");
const item: AttentionItem = { source: "codex", id, title: "Truncated display title…", state: "pending", createdAt: 1, updatedAt: 1,
  description: `Project: D:\\repo\nSession: ${session}\nTurn: ${turn}\nCall: ${call}\nTool: request_user_input_async\n\n1. Truncated display text…` };
const original = [{ title: 'Full café question\n1. nested list\n- not an option <script>', options: ["First", "Second"] }, { title: "Anything else?" }];
const reply = (index: number, overrides: object = {}) => ({ questionItemId: questionReplyId(call, index), question: original[index].title, answer: "Answered", ...overrides });
const envelope = (replies: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

async function fixture(extra: any[] = [], questions: any[] = original) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-question-test-"));
  const dir = path.join(root, "2026", "10", "22"); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-22T10-00-00-${session}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id: session } }, { type: "turn_context", payload: { turn_id: turn } },
    { type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions }) } }, ...extra];
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const messages = { send: jest.fn(async (_item: AttentionItem, _message: unknown): Promise<CodexMessageReceipt> => ({ sessionId: session, turnId: turn, delivery: "steered" })) };
  return { root, file, rows, messages, service: new CodexQuestionService(messages, root) };
}

test("loads complete questions and choices for legacy hook items without guessing from display text", async () => {
  const { service } = await fixture();
  expect(await service.questions(item)).toEqual(original.map((question, index) => ({ index, title: question.title, options: question.options || [], answered: false })));
  expect(hasCodexAsyncQuestion(item)).toBe(true);
  expect(hasCodexAsyncQuestion({ ...item, source: "other" })).toBe(false);
});

test("sends exact question identities and literal answers in one envelope without changing the source item", async () => {
  const { service, messages } = await fixture();
  const answer = 'Keep café 🙂\n</send_user_message_question_reply> $(literal)';
  const receipt = await service.answer(item, [{ index: 1, answer: "No" }, { index: 0, answer }]);
  expect(receipt.delivery).toBe("steered");
  expect(messages.send).toHaveBeenCalledWith(item, envelope([reply(0, { answer }), reply(1, { answer: "No" })]));
  expect(item.state).toBe("pending");
  await expect(service.answer(item, [{ index: 0, answer }, { index: 1, answer: "No" }])).rejects.toThrow("already answered");
  expect(messages.send).toHaveBeenCalledTimes(1);
});

test("recognizes structured replies, ignores ordinary chat and wrong identities, and sends only unanswered questions", async () => {
  const { service, messages } = await fixture([user("First"), user(envelope(reply(1, { questionItemId: questionReplyId("other", 1) }))),
    user(envelope(reply(1, { question: "Wrong question" }))), user(envelope(reply(0)))]);
  expect((await service.questions(item)).map(question => question.answered)).toEqual([true, false]);
  await service.answer(item, [{ index: 1, answer: "Continue" }]);
  expect(parseQuestionReplies(messages.send.mock.calls[0][1] as string)).toEqual([reply(1, { answer: "Continue" })]);
});

test("an answered transcript remains answered after a service restart", async () => {
  const { service, messages } = await fixture([user(envelope([reply(0), reply(1)]))]);
  await expect(service.answer(item, [{ index: 0, answer: "First" }, { index: 1, answer: "No" }])).rejects.toThrow("already answered in Codex");
  expect(messages.send).not.toHaveBeenCalled();
});

test.each([null, [], [{ index: 0, answer: "First" }, { index: 0, answer: "Again" }],
  [{ index: 0, answer: "First" }, { index: 5, answer: "Wrong" }], [{ index: 0, answer: "" }, { index: 1, answer: "No" }]]
  .map(answers => ({ answers })))("rejects missing, duplicate, unknown, or empty answers: $answers", async ({ answers }) => {
  const { service, messages } = await fixture();
  await expect(service.answer(item, answers)).rejects.toThrow("an unanswered question");
  expect(messages.send).not.toHaveBeenCalled();
});

test("rejects oversized envelopes before delivery", async () => {
  const { service, messages } = await fixture();
  await expect(service.answer(item, [{ index: 0, answer: "x".repeat(20000) }, { index: 1, answer: "No" }])).rejects.toThrow("message limit");
  expect(messages.send).not.toHaveBeenCalled();
});

test("submits choices individually, retains unanswered questions, and rejects repeating an accepted answer", async () => {
  const { service, messages } = await fixture();
  expect((await service.answer(item, [{ index: 0, answer: "First" }])).remainingQuestions).toBe(1);
  expect(parseQuestionReplies(messages.send.mock.calls[0][1] as string)).toEqual([reply(0, { answer: "First" })]);
  expect((await service.questions(item)).map(question => question.answered)).toEqual([true, false]);
  await expect(service.answer(item, [{ index: 0, answer: "Second" }])).rejects.toThrow("an unanswered question");
  expect(messages.send).toHaveBeenCalledTimes(1);
  expect((await service.answer(item, [{ index: 1, answer: "Manual answer" }])).remainingQuestions).toBe(0);
  expect((await service.questions(item)).every(question => question.answered)).toBe(true);
});

test("a failed later answer preserves earlier accepted answers without replay", async () => {
  const { service, messages } = await fixture();
  await service.answer(item, [{ index: 1, answer: "No" }]);
  messages.send.mockRejectedValue(new Error("Delivery unknown"));
  await expect(service.answer(item, [{ index: 0, answer: "First" }])).rejects.toThrow("Delivery unknown");
  expect((await service.questions(item)).map(question => question.answered)).toEqual([false, true]);
  expect(messages.send).toHaveBeenCalledTimes(2);
});

test.each([
  { id: "question-forged" }, { codexSessionId: "different-session" }, { source: "other" },
  { description: item.description!.replace("request_user_input_async", "request_user_input") },
])("rejects an unverifiable or blocking question before sending: %j", async overrides => {
  const { service, messages } = await fixture();
  await expect(service.answer({ ...item, ...overrides }, [])).rejects.toThrow();
  expect(messages.send).not.toHaveBeenCalled();
});

test("rejects a transcript belonging to a different session or turn", async () => {
  const { service, file, rows, messages } = await fixture();
  rows[0].payload.id = "other";
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join("\n"));
  await expect(service.questions(item)).rejects.toThrow("verified original question");
  rows[0].payload.id = session; rows[1].payload.turn_id = "other";
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join("\n"));
  await expect(service.questions(item)).rejects.toThrow("verified original question");
  expect(messages.send).not.toHaveBeenCalled();
});

test("a missing original transcript fails visibly", async () => {
  const { service } = await fixture();
  const missing = { ...item, id: "question-" + createHash("sha256").update(JSON.stringify(["missing", turn, call])).digest("hex"),
    description: item.description!.replace("Session: session-a", "Session: missing") };
  await expect(service.questions(missing)).rejects.toThrow("unavailable locally");
});

test("a partially written final line does not hide the original question", async () => {
  const { service, file } = await fixture();
  await fs.appendFile(file, '{"type":"response_item"');
  expect(await service.questions(item)).toHaveLength(2);
});

test("blocks duplicate submissions during transcript loading and delivery", async () => {
  const { service, messages } = await fixture();
  let release!: (receipt: CodexMessageReceipt) => void;
  messages.send.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const answers = [{ index: 0, answer: "First" }, { index: 1, answer: "No" }];
  const pending = service.answer(item, answers);
  await expect(service.answer(item, answers)).rejects.toThrow("already being sent");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ sessionId: session, turnId: turn, delivery: "steered" }); await pending;
  expect(messages.send).toHaveBeenCalledTimes(1);
});

test("failed or uncertain sends are not replayed or marked answered", async () => {
  const { service, messages } = await fixture();
  messages.send.mockRejectedValue(new Error("Delivery unknown; check Codex"));
  await expect(service.answer(item, [{ index: 0, answer: "First" }, { index: 1, answer: "No" }])).rejects.toThrow("Delivery unknown");
  expect(messages.send).toHaveBeenCalledTimes(1);
  expect((await service.questions(item)).every(question => !question.answered)).toBe(true);
});

test("Done items cannot be answered again", async () => {
  const { service, messages } = await fixture();
  await expect(service.answer({ ...item, state: "done" }, [])).rejects.toThrow("already answered");
  expect(messages.send).not.toHaveBeenCalled();
});
