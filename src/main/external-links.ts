import { isWebLink } from "../shared/web-link";
import { editorFileHref, localFileLink } from "../shared/attention-link";

/** Keep linked pages outside the privileged desktop window and its preload. */
export function externalLinkHandler(openUrl: (url: string) => Promise<unknown>) {
  return ({ url }: { url: string }): { action: "deny" } => {
    const file = localFileLink(url);
    const destination = isWebLink(url) ? url : file ? editorFileHref(file) : undefined;
    if (destination) void openUrl(destination).catch(error => console.error("Could not open attention link", error));
    return { action: "deny" };
  };
}
