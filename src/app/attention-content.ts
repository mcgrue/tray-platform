import { AttentionItem } from "../shared/attention";

/** Presentation only: retain the original header for question identity checks. */
export function attentionContent(item: AttentionItem) {
  const title = item.source === "codex" ? item.title.replace(/^Codex needs input:\s*/, "") : item.title;
  const description = item.description || "";
  const header = item.source === "codex"
    ? /^(Project: [^\r\n]+\r?\nSession: [^\r\n]+\r?\nTurn: [^\r\n]+\r?\nCall: [^\r\n]+\r?\nTool: [^\r\n]+)\r?\n\r?\n/.exec(description)
    : null;
  return { title, description: header ? description.slice(header[0].length) : description, diagnostics: header?.[1] || "" };
}
