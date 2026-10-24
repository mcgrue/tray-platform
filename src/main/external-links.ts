import { isWebLink } from "../shared/web-link";

/** Keep linked pages outside the privileged desktop window and its preload. */
export function externalLinkHandler(openUrl: (url: string) => Promise<unknown>) {
  return ({ url }: { url: string }): { action: "deny" } => {
    if (isWebLink(url)) void openUrl(url).catch(error => console.error("Could not open attention link", error));
    return { action: "deny" };
  };
}
