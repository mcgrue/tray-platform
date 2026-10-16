import { IncomingMessage, ServerResponse } from "http";
import { AttentionError } from "./attention-service";
import { isLoopback, readJson, sendJson } from "./attention-api";
import { BookmarkService } from "./bookmark-service";

export function createBookmarkApi(options: { bookmarks: BookmarkService }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = (req.url || "").split("?")[0];
    if (pathname !== "/api/bookmarks" && !pathname.startsWith("/api/bookmarks/")) return false;
    try {
      if (!isLoopback(req.socket.remoteAddress)) throw new AttentionError("API is available only to loopback callers", 403);
      if (req.headers.origin) throw new AttentionError("Browser-origin API calls are not permitted", 403);
      if (pathname === "/api/bookmarks") {
        if (req.method !== "GET") throw new AttentionError("Method not allowed", 405);
        sendJson(res, 200, options.bookmarks.list());
      } else {
        const match = /^\/api\/bookmarks\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (!match) throw new AttentionError("API endpoint not found", 404);
        if (req.method !== "PUT") throw new AttentionError("Method not allowed", 405);
        let source: string, id: string;
        try { source = decodeURIComponent(match[1]); id = decodeURIComponent(match[2]); }
        catch { throw new AttentionError("Invalid URL encoding", 400); }
        const bookmark = await options.bookmarks.upsertRobot(source, id, await readJson(req));
        sendJson(res, 200, { bookmark });
      }
    } catch (error) {
      sendJson(res, error instanceof AttentionError ? error.status : 500, {
        error: error instanceof AttentionError ? error.message : "Bookmark request failed",
      });
    }
    return true;
  };
}
