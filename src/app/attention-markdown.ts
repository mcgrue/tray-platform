import MarkdownIt from "markdown-it";
import { isWebLink } from "../shared/web-link";

// Attention text comes from hooks and external clients. Never enable raw HTML or
// arbitrary plugins here: the generated markup is inserted into the shared UI.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.validateLink = isWebLink;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
// Keep image descriptions without fetching remote resources from notifications.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  markdown.utils.escapeHtml(renderer.renderInlineAsText(tokens[index].children || [], options, env));
markdown.renderer.rules.table_open = () => '<div class="attention-markdown-table" tabindex="0" role="region" aria-label="Table"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

export function renderAttentionMarkdown(text: string): string {
  return markdown.render(text);
}
