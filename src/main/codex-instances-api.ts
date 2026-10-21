import { IncomingMessage, ServerResponse } from "http";
import { CodexInstanceService } from "./codex-instance-service";
import { isLoopback, sendJson } from "./attention-api";

export function createCodexInstancesApi(service: Pick<CodexInstanceService, "list">) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.url || "").split("?")[0] !== "/api/codex-instances") return false;
    if (!isLoopback(req.socket.remoteAddress) || req.headers.origin) sendJson(res, 403, { error: "API is available only to local non-browser callers" });
    else if (req.method !== "GET") sendJson(res, 405, { error: "Method not allowed" });
    else sendJson(res, 200, service.list());
    return true;
  };
}
