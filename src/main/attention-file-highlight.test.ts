import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AttentionItem } from "../shared/attention";
import { attentionFileResponse } from "./attention-files";
import { highlightFileSource, MAX_HIGHLIGHT_CHARACTERS } from "./attention-file-highlight";

const visibleText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|#x27);/g,
  (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }[entity]!));

test.each([
  ["demo.ts", "typescript", 'export const count: number = 42;'],
  ["demo.TSX", "typescript", 'export const App = () => <div>Hello</div>;'],
  ["demo.cjs", "javascript", 'const greeting = "hello";'],
  ["demo.cpp", "cpp", 'int main() { return 42; }'],
  ["demo.cs", "csharp", 'public class Demo { public int Count = 42; }'],
  ["demo.py", "python", 'def hello(): return "world"'],
  ["demo.ps1", "powershell", 'function Get-Demo { return "hello" }'],
  ["demo.json", "json", '{"count": 42, "ready": true}'],
  ["demo.yaml", "yaml", 'count: 42\nready: true'],
  ["demo.sh", "bash", 'echo "hello"'],
  ["demo.rs", "rust", 'fn main() { let count = 42; }'],
  ["demo.css", "css", '.demo { color: red; }'],
])("colors %s without changing its text", (filename, language, text) => {
  const source = highlightFileSource(text, filename);
  expect(source.language).toBe(language);
  expect(source.html).toContain('class="hljs-');
  expect(visibleText(source.html)).toBe(text);
});

test("multiline tokens preserve their colors and independent line anchors", () => {
  const text = '/* first\r\n * second\r\n */\r\nconst message = `first\r\nsecond`;\r\n';
  const source = highlightFileSource(text, "demo.ts");
  const lines = source.html.split("\n");
  expect(lines).toHaveLength(6);
  lines.forEach((line, i) => {
    expect(line).toMatch(new RegExp(`^<span id="L${i + 1}">`));
    expect((line.match(/<span\b/g) || []).length).toBe((line.match(/<\/span>/g) || []).length);
  });
  expect(lines[1]).toContain('class="hljs-comment"');
  expect(lines[4]).toContain('class="hljs-string"');
  expect(visibleText(source.html)).toBe(text.replace(/\r\n/g, "\n"));
});

test("HTML, SVG and script-like strings remain escaped source, never active markup", () => {
  for (const filename of ["page.html", "image.svg", "code.ts", "notes.txt"]) {
    const text = '<script>window.pwned = true</script>\n<img src=x onerror="alert(1)"> & </style>';
    const source = highlightFileSource(text, filename);
    expect(source.html).not.toMatch(/<(?:script|img|style)\b|<\/style>/);
    expect(visibleText(source.html)).toBe(text);
    expect(source.html.match(/<[^>]+>/g)?.every(tag => /^<span (?:id="L\d+"|class="[a-zA-Z0-9_ -]+")>$|^<\/span>$/.test(tag))).toBe(true);
  }
});

test("unknown formats and large sources keep a readable plain-text fallback", () => {
  for (const [filename, text] of [["notes.txt", "const x = '<tag>';"], ["file.constructor", "const x = 1;"],
    ["large.ts", "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1)]]) {
    const source = highlightFileSource(text, filename);
    expect(source.language).toBeUndefined();
    expect(source.html).not.toContain("hljs-");
    expect(visibleText(source.html)).toBe(text);
  }
});

test("file previews embed colors without scripts, while downloads preserve the original bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-highlight-test-"));
  const filename = path.join(root, "Demo source.ts");
  const bytes = Buffer.from('\ufeffexport const message = "<script>never run</script>";\r\n// Second line\r\n');
  await fs.writeFile(filename, bytes);
  const item: AttentionItem = { source: "demo", id: "syntax", title: "Syntax demo", state: "pending", createdAt: 1, updatedAt: 1,
    description: `[source](<${filename}:2>)` };
  const preview = await attentionFileResponse(item, filename + ":2", false, async () => []);
  expect(preview.body.toString()).toContain('data-language="typescript"');
  expect(preview.body.toString()).toContain('<span id="L2"><span class="hljs-comment">');
  expect(preview.body.toString()).toContain(".hljs-keyword");
  expect(preview.body.toString()).not.toContain("<script>");
  expect(preview.headers["Content-Security-Policy"]).not.toContain("allow-scripts");
  const download = await attentionFileResponse(item, filename + ":2", true, async () => []);
  expect(download.body).toEqual(bytes);
  expect(download.headers["Content-Disposition"]).toContain("attachment;");
});
