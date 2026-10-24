import { attentionOperations } from "./attention-operations";

test("shared answer operation dismisses only fully answered requests and does not replay a delivered answer on storage failure", async () => {
  const item = { source: "codex", id: "item" }, attention = { get: jest.fn(() => item), setState: jest.fn(async () => {}) };
  const answer = jest.fn().mockResolvedValueOnce({ remainingQuestions: 1 }).mockResolvedValue({ remainingQuestions: 0 });
  const operations = attentionOperations(attention as any, { send: jest.fn() }, { answer, questions: jest.fn() });
  await operations.answer("codex", "item", []); expect(attention.setState).not.toHaveBeenCalled();
  await operations.answer("codex", "item", []); expect(attention.setState).toHaveBeenCalledWith("codex", "item", "done");
  attention.setState.mockRejectedValueOnce(new Error("Disk full"));
  expect((await operations.answer("codex", "item", [])).warning).toContain("do not resend");
  expect(answer).toHaveBeenCalledTimes(3);
});
