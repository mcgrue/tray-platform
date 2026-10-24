import { promises as fs } from "fs";
import { AttentionItem } from "../shared/attention";
import { attentionFileHref, localFileHref, localFileLink } from "../shared/attention-link";
import { attentionLocalFileLinks } from "../shared/attention-markdown";
import { CodexQuestion, hasCodexAsyncQuestion } from "../shared/codex-question";
import { AttentionError } from "./attention-service";
import { FILE_SYNTAX_CSS, highlightFileSource } from "./attention-file-highlight";

export const MAX_ATTENTION_FILE_BYTES = 20 * 1024 * 1024;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

/** Authentication is performed by the web transport before this exact-link check. */
export async function attentionFileResponse(item: AttentionItem, target: string, download: boolean,
  questions: () => Promise<CodexQuestion[]>) {
  const link = localFileLink(target);
  if (!link) throw new AttentionError("Invalid local file link", 400);
  const canonical = localFileHref(link);
  let allowed = attentionLocalFileLinks(item.description || "").includes(canonical);
  if (!allowed && hasCodexAsyncQuestion(item)) {
    const prompts = await questions();
    allowed = prompts.some(question => attentionLocalFileLinks(question.title).includes(canonical));
  }
  if (!allowed) throw new AttentionError("This file is not linked from this attention item", 403);
  if (process.platform === "win32" ? !/^[A-Z]:\//.test(link.path) : !link.path.startsWith("/")) {
    throw new AttentionError("This file path belongs to a different operating system", 400);
  }
  let bytes: Buffer;
  try {
    const file = await fs.open(link.path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new AttentionError("The link does not point to a regular file", 400);
      if (stat.size > MAX_ATTENTION_FILE_BYTES) throw new AttentionError("Linked files must be 20 MB or smaller", 413);
      // A growing file cannot cause an unbounded read after the size check.
      const buffer = Buffer.alloc(stat.size);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof AttentionError) throw error;
    throw new AttentionError("The linked file is missing or cannot be read on the desktop", 404);
  }
  const filename = link.path.split("/").pop()!;
  const encodedName = encodeURIComponent(filename).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  const headers: Record<string, string> = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox allow-same-origin allow-downloads; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const text = !download && bytes.length <= 2 * 1024 * 1024 && !bytes.includes(0) ? bytes.toString("utf8") : undefined;
  if (text !== undefined && !text.includes("\ufffd")) {
    const downloadHref = attentionFileHref(item, canonical).split("#")[0] + "&download=1";
    const source = highlightFileSource(text, filename);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(filename)}</title>
<style>body{margin:0;padding:20px;background:#0f172a;color:#e2e8f0;font:15px/1.6 system-ui}header{display:flex;gap:20px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}strong{overflow-wrap:anywhere}a{color:#a5b4fc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace;tab-size:4}pre>span:target{background:#394668}${FILE_SYNTAX_CSS}</style></head>
<body><header><strong>${escape(filename)}</strong><a href="${escape(downloadHref)}" download>Download</a></header><pre${source.language ? ` data-language="${source.language}"` : ""}>${source.html}</pre></body></html>`;
    return { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: Buffer.from(html) };
  }
  return { headers: { ...headers, "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}` }, body: bytes };
}
