import MarkdownIt from "markdown-it";
import { isWebLink } from "./web-link";
import { localFileHref, localFileLink } from "./attention-link";

export interface AttentionMarkdownOptions { localLink?: (href: string) => string; }

// Shared by the renderers and file-route authorization. Raw HTML stays inert.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.validateLink = value => isWebLink(value) || Boolean(localFileLink(value));
markdown.renderer.rules.link_open = (tokens, index, options, env: AttentionMarkdownOptions, renderer) => {
  const token = tokens[index], local = localFileLink(token.attrGet("href") || "");
  if (local) {
    const href = localFileHref(local);
    token.attrSet("href", env?.localLink ? env.localLink(href) : href);
    token.attrSet("data-local-file-link", "");
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  markdown.utils.escapeHtml(renderer.renderInlineAsText(tokens[index].children || [], options, env));
markdown.renderer.rules.table_open = () => '<div class="attention-markdown-table" tabindex="0" role="region" aria-label="Table"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

export function renderAttentionMarkdown(text: string, options: AttentionMarkdownOptions = {}): string {
  return markdown.render(text, options);
}

/** Only actual clickable Markdown links count; code, raw HTML and images do not grant access. */
export function attentionLocalFileLinks(text: string): string[] {
  const links = new Set<string>();
  const visit = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const token of tokens) {
      if (token.type === "link_open") {
        const link = localFileLink(token.attrGet("href") || "");
        if (link) links.add(localFileHref(link));
      }
      if (token.children && token.type !== "image") visit(token.children);
    }
  };
  visit(markdown.parse(text, {}));
  return [...links];
}
