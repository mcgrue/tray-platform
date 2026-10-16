import { IncomingMessage, ServerResponse } from "http";
import { isIP } from "net";
import { WindowDestination } from "../shared/attention";
import { AttentionError, AttentionService } from "./attention-service";

export const MAX_ATTENTION_BODY_BYTES = 65536;

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const ipv4 = address.replace(/^::ffff:/i, "");
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ATTENTION_BODY_BYTES) finish(new AttentionError("Request body is too large", 413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        finish(undefined, value);
      } catch { finish(new AttentionError("Expected a JSON object", 400)); }
    };
    const onError = () => finish(new AttentionError("Request body could not be read", 400));
    const onAborted = () => finish(new AttentionError("Request aborted", 400));
    const timer = setTimeout(() => finish(new AttentionError("Request body timed out", 408)), 10000);
    timer.unref?.();
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError); req.on("aborted", onAborted);
  });
}

export function createAttentionApi(options: { attention: AttentionService; desktop: { listWindows(): Promise<WindowDestination[]> } }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = (req.url || "").split("?")[0];
    if (!pathname.startsWith("/api/")) return false;
    try {
      if (!isLoopback(req.socket.remoteAddress)) throw new AttentionError("API is available only to loopback callers", 403);
      if (req.headers.origin) throw new AttentionError("Browser-origin API calls are not permitted", 403);
      if (pathname === "/api/attention" && req.method === "GET") {
        sendJson(res, 200, options.attention.list());
      } else if (pathname === "/api/windows" && req.method === "GET") {
        sendJson(res, 200, { windows: await options.desktop.listWindows() });
      } else {
        if (pathname === "/api/attention" || pathname === "/api/windows") throw new AttentionError("Method not allowed", 405);
        const match = /^\/api\/attention\/([^/]+)\/([^/]+)(\/state)?$/.exec(pathname);
        if (!match) throw new AttentionError("API endpoint not found", 404);
        let source: string, id: string;
        try { source = decodeURIComponent(match[1]); id = decodeURIComponent(match[2]); }
        catch { throw new AttentionError("Invalid URL encoding", 400); }
        if (!match[3] && req.method === "PUT") {
          const item = await options.attention.upsert(source, id, await readJson(req));
          sendJson(res, 200, { item });
        } else if (match[3] && req.method === "POST") {
          const input = await readJson(req);
          await options.attention.setState(source, id, input.state, input.minutes);
          sendJson(res, 200, { ok: true });
        } else throw new AttentionError("Method not allowed", 405);
      }
    } catch (error) {
      sendJson(res, error instanceof AttentionError ? error.status : 500, { error: error instanceof AttentionError ? error.message : "Attention request failed" });
    }
    return true;
  };
}
