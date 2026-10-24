import { renderAttentionMarkdown } from "./attention-markdown";

test("renders common Markdown blocks and inline formatting", () => {
  const html = renderAttentionMarkdown("## Result\n\n**Ready** with *emphasis*, ~~old~~ and `code`.\n\n- First\n- Second\n\n1. Run\n2. Check\n\n> Quoted\n\n```ts\nconst value = '<safe>';\n```\n\n| Item | State |\n| --- | --- |\n| Test | Passed |");
  for (const tag of ["h2", "strong", "em", "s", "code", "ul", "ol", "li", "blockquote", "pre", "table", "th", "td"]) {
    expect(html).toMatch(new RegExp(`<${tag}[ >]`));
  }
  expect(html).toContain("&lt;safe&gt;");
  expect(html).toContain('class="attention-markdown-table"');
});

test("retains plain text line breaks and escapes raw HTML", () => {
  const html = renderAttentionMarkdown('First line\nSecond line\n\n<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
  expect(html).toContain("First line<br>\nSecond line");
  expect(html).not.toMatch(/<(script|img)\b/);
  expect(html).toContain("&lt;script&gt;");
});

test("renders explicit and bare web links with a separate browsing context", () => {
  const html = renderAttentionMarkdown('[PR](https://github.com/mcgrue/tray-platform/pull/1 "Review")\nhttps://example.com/status');
  expect(html).toContain('href="https://github.com/mcgrue/tray-platform/pull/1"');
  expect(html).toContain('href="https://example.com/status"');
  expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2);
});

test.each([
  "javascript:alert%281%29", "javascript&#58;alert%281%29", "JaVaScRiPt:alert%281%29",
  "data:text/html,payload", "file:///C:/secret.txt", "vscode://file/C:/secret.txt",
  "/api/attention", "../secret.txt", "//example.com", "#attention", "mailto:user@example.com",
  "https://user:password@example.com", "https://",
])("keeps non-web destination %s inert", destination => {
  expect(renderAttentionMarkdown(`[Open](${destination})`)).not.toContain("<a ");
});

test("image syntax displays alt text without loading resources", () => {
  const html = renderAttentionMarkdown('![Diagram **label**](https://example.com/tracker.png)');
  expect(html).toContain("Diagram label");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("tracker.png");
});

test("escapes link titles, code-fence attributes, and image descriptions", () => {
  const html = renderAttentionMarkdown('[Link](https://example.com "\" onmouseover=\"alert(1)")\n\n```x\" onmouseover=\"alert(1)\n<script>bad</script>\n```\n\n![<img src=x onerror=alert(1)>](https://example.com/a.png)');
  expect(html).not.toMatch(/<script|<img|" onmouseover="/);
});
