import { AttentionItem } from "../shared/attention";
import { hasCodexAsyncQuestion } from "../shared/codex-question";

/** Presentation only: retain the original header for question identity checks. */
export function attentionContent(item: AttentionItem) {
  const originalTitle = item.source === "codex" ? item.title.replace(/^Codex needs input:\s*/, "") : item.title;
  // The hook may use the entire multiline prompt as its title. Keep the card
  // heading compact; the verified question below contains the complete prompt.
  const title = hasCodexAsyncQuestion(item)
    ? originalTitle.split(/\r?\n/).find(line => line.trim())?.trim() || originalTitle
    : originalTitle;
  const description = item.description || "";
  const header = item.source === "codex"
    ? /^(Project: [^\r\n]+\r?\nSession: [^\r\n]+\r?\nTurn: [^\r\n]+\r?\nCall: [^\r\n]+\r?\nTool: [^\r\n]+)\r?\n\r?\n/.exec(description)
    : null;
  return { title, description: header ? description.slice(header[0].length) : description, diagnostics: header?.[1] || "" };
}
