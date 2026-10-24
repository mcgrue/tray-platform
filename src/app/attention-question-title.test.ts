import { attentionContent } from "./attention-content";
import { AttentionItem } from "../shared/attention";
import { legacyCodexIdentity } from "../shared/codex-message";

const item: AttentionItem = {
  source: "codex", id: "question-fixture", state: "pending", createdAt: 1, updatedAt: 1,
  title: "Codex needs input: Markdown demo\n\n## Full question\n\n**Details** and `code`",
  description: "Project: fixture\nSession: session\nTurn: turn\nCall: call\nTool: request_user_input_async\n\nFull question preview",
};

test.each(["\n", "\r\n"])("uses the first nonempty question title line with %j without changing identity", newline => {
  const original = { ...item, title: item.title.replace(/\n/g, newline), description: item.description!.replace(/\n/g, newline) };
  const before = JSON.stringify(original);
  expect(attentionContent(original).title).toBe("Markdown demo");
  expect(legacyCodexIdentity(original)).toEqual({ session: "session", turn: "turn", call: "call" });
  expect(JSON.stringify(original)).toBe(before);
});

test("keeps a short question heading and skips empty first lines", () => {
  expect(attentionContent({ ...item, title: "Short question?" }).title).toBe("Short question?");
  expect(attentionContent({ ...item, title: "\n  \n  Markdown demo  \nBody" }).title).toBe("Markdown demo");
});

test("does not shorten ordinary item titles", () => {
  expect(attentionContent({ ...item, source: "other" }).title).toBe(item.title);
  expect(attentionContent({ ...item, description: "A normal completion" }).title).toBe(item.title.replace("Codex needs input: ", ""));
});
