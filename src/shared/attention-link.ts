import { isWebLink } from "./web-link";

export interface LocalFileLink { path: string; line?: number; column?: number; }

/** Absolute local paths only. Network shares, device paths and arbitrary URI handlers are excluded. */
export function localFileLink(value: string): LocalFileLink | undefined {
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value) || isWebLink(value)) return;
  let file = value;
  try {
    if (/^file:/i.test(file)) {
      const url = new URL(file);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search ||
        (url.hash && !/^#L\d+(?:C\d+)?$/.test(url.hash))) return;
      file = url.pathname + url.hash;
    }
    file = decodeURIComponent(file);
  } catch { return; }
  if (/[\u0000-\u001f\u007f]/.test(file)) return;
  file = file.replace(/\\/g, "/");
  if (file.startsWith("//")) return;
  file = file.replace(/^\/([a-z]:\/)/i, "$1");
  const windows = /^[a-z]:\//i.test(file);
  if (!windows && !file.startsWith("/")) return;
  const position = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/.exec(file);
  let line: number | undefined, column: number | undefined;
  if (position) {
    line = Number(position[1] || position[3]);
    column = position[2] || position[4] ? Number(position[2] || position[4]) : undefined;
    if (!Number.isSafeInteger(line) || line < 1 || line > 2147483647 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 2147483647))) return;
    file = file.slice(0, position.index);
  }
  const prefix = windows ? file.slice(0, 2).toUpperCase() + "/" : "/";
  const segments: string[] = [];
  for (const segment of file.slice(windows ? 3 : 1).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!segments.length) return; segments.pop(); continue; }
    if (windows && (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return;
    segments.push(segment);
  }
  if (!segments.length) return;
  return { path: prefix + segments.join("/"), ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

const encodedPath = (link: LocalFileLink) => link.path.split("/").map((part, i) =>
  i === 0 && /^[A-Z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");

export function localFileHref(link: LocalFileLink): string {
  return `file://${link.path.startsWith("/") ? "" : "/"}${encodedPath(link)}${link.line ? `#L${link.line}${link.column ? `C${link.column}` : ""}` : ""}`;
}

export function editorFileHref(link: LocalFileLink): string {
  // https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls
  return `vscode://file${link.path.startsWith("/") ? "" : "/"}${encodedPath(link)}${link.line ? `:${link.line}${link.column ? `:${link.column}` : ""}` : ""}`;
}

export function attentionFileHref(item: { source: string; id: string }, href: string): string {
  const link = localFileLink(href);
  if (!link) throw new Error("Invalid local file link");
  return `/api/attention/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}/file?target=${encodeURIComponent(localFileHref(link))}${link.line ? `#L${link.line}` : ""}`;
}
