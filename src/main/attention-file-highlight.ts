import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const highlighter = hljs.newInstance();
Object.entries({ bash, c, cpp, csharp, css, go, ini, java, javascript, json, lua, powershell,
  python, rust, sql, typescript, xml, yaml }).forEach(([name, grammar]) => highlighter.registerLanguage(name, grammar));

const extensions = new Map([
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["c", "c"], ["h", "cpp"], ["cc", "cpp"], ["cpp", "cpp"], ["cxx", "cpp"], ["hpp", "cpp"], ["hxx", "cpp"],
  ["cs", "csharp"], ["css", "css"], ["go", "go"], ["ini", "ini"], ["toml", "ini"], ["java", "java"],
  ["json", "json"], ["jsonc", "json"], ["lua", "lua"], ["ps1", "powershell"], ["psm1", "powershell"],
  ["psd1", "powershell"], ["py", "python"], ["pyi", "python"], ["rs", "rust"], ["sh", "bash"],
  ["bash", "bash"], ["zsh", "bash"], ["sql", "sql"], ["html", "xml"], ["htm", "xml"], ["xml", "xml"],
  ["svg", "xml"], ["xaml", "xml"], ["yaml", "yaml"], ["yml", "yaml"],
]);

// Bound synchronous parsing on the desktop; larger previews remain readable as plain text.
export const MAX_HIGHLIGHT_CHARACTERS = 100_000;
const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function highlightFileSource(text: string, filename: string): { html: string; language?: string } {
  const source = text.replace(/\r\n/g, "\n");
  let language = extensions.get(filename.split(".").pop()!.toLowerCase());
  let html = escape(source);
  if (language && source.length <= MAX_HIGHLIGHT_CHARACTERS) {
    try { html = highlighter.highlight(source, { language, ignoreIllegals: true }).value; }
    catch { language = undefined; }
  } else { language = undefined; }

  // Tokenize the whole file, then balance token spans on each line. Multiline
  // strings/comments keep their colors without swallowing the #L<n> anchors.
  const open: string[] = [];
  const lines = html.split("\n").map((line, index) => {
    const continued = open.join("");
    for (const tag of line.match(/<span\b[^>]*>|<\/span>/g) || []) {
      if (tag === "</span>") open.pop(); else open.push(tag);
    }
    return `<span id="L${index + 1}">${continued}${line}${"</span>".repeat(open.length)}</span>`;
  });
  return { html: lines.join("\n"), language };
}

export const FILE_SYNTAX_CSS = `
.hljs-keyword,.hljs-selector-tag,.hljs-meta,.hljs-doctag{color:#c4b5fd}
.hljs-string,.hljs-regexp,.hljs-template-tag{color:#a7f3d0}
.hljs-number,.hljs-literal,.hljs-symbol,.hljs-bullet{color:#fdba74}
.hljs-title,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#7dd3fc}
.hljs-type,.hljs-built_in,.hljs-attr,.hljs-attribute,.hljs-variable{color:#fde68a}
.hljs-comment,.hljs-quote{color:#94a3b8;font-style:italic}
.hljs-subst{color:#e2e8f0}`;
