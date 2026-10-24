import { attentionFileHref, editorFileHref, localFileHref, localFileLink } from "./attention-link";
import { attentionLocalFileLinks, renderAttentionMarkdown } from "./attention-markdown";

test.each([
  ["D:/dev/grue/breaditor-v2/PLAN.md", "D:/dev/grue/breaditor-v2/PLAN.md"],
  ["d:\\My Project\\PLAN.md:12:3", "D:/My Project/PLAN.md"],
  ["/D:/My%20Project/PLAN.md#L12C3", "D:/My Project/PLAN.md"],
  ["file:///D:/My%20Project/PLAN.md#L12C3", "D:/My Project/PLAN.md"],
  ["/home/user/main.ts:12:3", "/home/user/main.ts"],
])("normalizes %s without losing the file identity", (input, path) => {
  const link = localFileLink(input)!; expect(link.path).toBe(path);
  expect(localFileLink(localFileHref(link))).toEqual(link);
  if (input.includes("12")) expect(link).toMatchObject({ line: 12, column: 3 });
});

test.each(["https://example.com", "javascript:alert(1)", "command:workbench.action.terminal.new", "vscode://settings/test",
  "../PLAN.md", "D:relative.md", "//server/share/doc.md", "\\\\server\\share\\doc.md", "file://server/share/doc.md",
  "\\\\?\\D:\\doc.md", "file:///D:/doc.md?command=run", "D:/doc.md:stream", "D:/nul", "D:/CON.txt",
  "D:/a/%00doc.md", "D:/a/%0adoc.md", "D:/doc.md:0", "D:/../doc.md", "file:///%2fserver/doc.md"])("rejects ambiguous or non-local destination %s", value => {
  expect(localFileLink(value)).toBeUndefined();
});

test("renders the reported named link and routes phone links through their attention item", () => {
  const input = "[manual checks](D:/dev/grue/breaditor-v2/ENTITY-CLICK-PLACEMENT-PLAN.md)";
  expect(renderAttentionMarkdown(input)).toContain('href="file:///D:/dev/grue/breaditor-v2/ENTITY-CLICK-PLACEMENT-PLAN.md"');
  expect(renderAttentionMarkdown(input)).toContain(">manual checks</a>");
  const phone = renderAttentionMarkdown(input, { localLink: href => attentionFileHref({ source: "codex", id: "done" }, href) });
  expect(phone).toContain('href="/api/attention/codex/done/file?target=file%3A%2F%2F%2FD%3A%2Fdev');
  expect(phone).not.toContain('href="file:');
  expect(phone).toContain('target="_blank" rel="noopener noreferrer"');
});

test("preserves spaces, punctuation, Unicode and positions in named and reference links", () => {
  const markdown = "[my file](<D:/My Project/café (notes).md:12>)\n\n[Reference][ref]\n\n[ref]: /home/me/main.ts:3:2";
  const html = renderAttentionMarkdown(markdown);
  expect(html).toContain("my file</a>"); expect(html).toContain("My%20Project/caf%C3%A9%20(notes).md#L12");
  expect(html).toContain('href="file:///home/me/main.ts#L3C2"');
  expect(editorFileHref(localFileLink("/home/me/a#b.ts:3")!)).toBe("vscode://file/home/me/a%23b.ts:3");
});

test("only clickable link tokens authorize file access", () => {
  const text = "[open](D:/project/allowed.md)\n\n`[code](D:/project/secret.txt)`\n\n```\n[x](D:/project/hidden.txt)\n```\n![image](D:/project/image.png)\n<a href='file:///D:/project/raw.txt'>Raw</a>";
  expect(attentionLocalFileLinks(text)).toEqual(["file:///D:/project/allowed.md"]);
});
