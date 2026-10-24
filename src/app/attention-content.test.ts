import { attentionContent } from "./attention-content";
import { AttentionItem } from "../shared/attention";

const item: AttentionItem = { source: "codex", id: "question", title: "Codex needs input: Keep this question?", state: "pending", createdAt: 1, updatedAt: 1 };
const header = "Project: D:\\repo\nSession: session\nTurn: turn\nCall: call\nTool: request_user_input_async";

test.each(["\n", "\r\n"])("separates the original hook header without changing persisted identity (%j)", newline => {
  const description = (header + "\n\n1. Keep this question?\n- Yes\n\nExtra context").replace(/\n/g, newline);
  const original = { ...item, description };
  expect(attentionContent(original)).toEqual({ title: "Keep this question?", diagnostics: header.replace(/\n/g, newline),
    description: ("1. Keep this question?\n- Yes\n\nExtra context").replace(/\n/g, newline) });
  expect(original.description).toBe(description);
  expect(original.title).toBe(item.title);
});

test("does not hide ordinary descriptions or alter another source's title", () => {
  const description = "Project: a normal sentence\n\nSession: more prose";
  expect(attentionContent({ ...item, description })).toEqual({ title: "Keep this question?", description, diagnostics: "" });
  expect(attentionContent({ ...item, source: "build", description: header + "\n\nBody" })).toEqual({
    title: item.title, description: header + "\n\nBody", diagnostics: "" });
});
