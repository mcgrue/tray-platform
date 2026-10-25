import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { promises as fs } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { AttentionError, AttentionService, validateAttentionIdentity } from "./attention-service";
import { isLoopback, readJson, sendJson } from "./attention-api";
import { attentionOperations } from "./attention-operations";
import { WebReceipts } from "./web-receipts";
import { WebPushService } from "./web-push-service";
import { readWebStore } from "./web-store";
import { attentionFileResponse } from "./attention-files";
import { CodexInstanceService } from "./codex-instance-service";
import { CodexInstanceMessages } from "./codex-instance-messages";
import { CodexAttachments } from "./codex-attachments";
import { MAX_CODEX_UPLOAD_BODY } from "../shared/codex-attachments";

export interface WebCodexInstances {
  instances: Pick<CodexInstanceService, "list" | "refresh" | "onChanged">;
  messages: Pick<CodexInstanceMessages, "conversations" | "send">;
}

export interface AttentionWebConfig { origin: string; allowedUsers: string[]; port: number; }
export function validateWebConfig(value: any): AttentionWebConfig {
  let origin: URL;
  try { origin = new URL(value?.origin); } catch { throw new Error("Web config requires an HTTPS origin"); }
  if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password) throw new Error("Web origin must be an HTTPS origin without a path");
  if (!Array.isArray(value.allowedUsers) || !value.allowedUsers.length || value.allowedUsers.some((user: unknown) =>
    typeof user !== "string" || !user.trim() || user.length > 200 || /[^\x21-\x7e]/.test(user))) throw new Error("Web config requires explicit Tailscale login names");
  const port = value.port ?? 22223;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 22222) throw new Error("Invalid web port");
  return { origin: origin.origin, allowedUsers: value.allowedUsers, port };
}

const assetTypes: Record<string, string> = {
  "/": "text/html; charset=utf-8", "/index.html": "text/html; charset=utf-8",
  "/index.js": "text/javascript; charset=utf-8", "/index.css": "text/css; charset=utf-8",
  "/sw.js": "text/javascript; charset=utf-8", "/manifest.webmanifest": "application/manifest+json",
  "/icon-192.png": "image/png", "/icon-512.png": "image/png", "/offline.html": "text/html; charset=utf-8",
};

export function createAttentionWeb(options: {
  config: AttentionWebConfig; attention: AttentionService; operations: ReturnType<typeof attentionOperations>;
  receipts: WebReceipts; push: WebPushService; assets: string; codex?: WebCodexInstances; attachments?: CodexAttachments;
}) {
  const { config, attention, operations, receipts, push } = options;
  const resolveMessage = async (value: unknown, user: string) => {
    if (options.attachments) return options.attachments.message(value, "web:" + user);
    if (typeof value !== "string") throw new AttentionError("Attachments are unavailable", 503);
    return value;
  };
  const secret = randomBytes(32), streams = new Set<ServerResponse>();
  const csrf = (user: string) => createHmac("sha256", secret).update(user).digest("hex");
  const authorize = (req: IncomingMessage) => {
    const user = req.headers["tailscale-user-login"];
    if (!isLoopback(req.socket.remoteAddress) || typeof user !== "string" || !config.allowedUsers.includes(user)) throw new AttentionError("Tailscale identity is not authorized", 403);
    if (req.headers.host !== new URL(config.origin).host) throw new AttentionError("Unexpected host", 403);
    if (req.headers.origin && req.headers.origin !== config.origin) throw new AttentionError("Unexpected origin", 403);
    if ((req.url || "").startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site") throw new AttentionError("Cross-site API access is not permitted", 403);
    if (req.method === "POST") {
      const token = req.headers["x-tray-csrf"];
      if (req.headers.origin !== config.origin || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(csrf(user)))) throw new AttentionError("Reload the pane before sending", 403);
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"]))) throw new AttentionError("Expected application/json", 415);
    }
    return user;
  };
  const writeEvent = (res: ServerResponse, event: string, value: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const writeSnapshot = (res: ServerResponse) => writeEvent(res, "attention", attention.list());
  const unsubscribe = attention.onChanged(() => streams.forEach(writeSnapshot));
  const unsubscribeInstances = options.codex?.instances.onChanged(snapshot => streams.forEach(res => writeEvent(res, "codex-instances", snapshot)));
  const heartbeat = setInterval(() => streams.forEach(res => {
    if (res.writableLength > 1024 * 1024) res.destroy(); else res.write(": heartbeat\n\n");
  }), 20000); heartbeat.unref?.();
  const server = http.createServer((req, res) => { void (async () => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const user = authorize(req), pathname = (req.url || "").split("?")[0];
      if (req.method !== "GET" && req.method !== "POST") throw new AttentionError("Method not allowed", 405);
      if (pathname === "/api/attachments" && req.method === "POST") {
        if (!options.attachments) throw new AttentionError("Attachments are unavailable", 503);
        const input = await readJson(req, MAX_CODEX_UPLOAD_BODY, 90000);
        sendJson(res, 200, await options.attachments.upload(input, "web:" + user)); return;
      }
      if (req.method === "GET" && assetTypes[pathname]) {
        const file = pathname === "/" ? "index.html" : pathname.slice(1);
        const bytes = await fs.readFile(path.join(options.assets, file));
        res.writeHead(200, { "Content-Type": assetTypes[pathname], "Cache-Control": "no-store" }); res.end(bytes); return;
      }
      if (req.method === "GET" && pathname === "/api/session") { sendJson(res, 200, { csrf: csrf(user) }); return; }
      if (req.method === "GET" && pathname === "/api/attention") { sendJson(res, 200, attention.list()); return; }
      if (req.method === "GET" && pathname === "/api/events") {
        if (streams.size >= 20) throw new AttentionError("Too many open panes", 429);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        streams.add(res); res.on("close", () => streams.delete(res)); writeSnapshot(res);
        if (options.codex) writeEvent(res, "codex-instances", options.codex.instances.list());
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/api/requests/")) {
        const receipt = receipts.get(user, pathname.slice("/api/requests/".length));
        if (!receipt) throw new AttentionError("No delivery receipt found; check Codex before sending again", 404);
        sendJson(res, 200, receipt); return;
      }
      if (req.method === "GET" && pathname === "/api/push/public-key") { sendJson(res, 200, { publicKey: push.publicKey }); return; }
      if (options.codex && pathname.startsWith("/api/codex-instances")) {
        const { instances, messages } = options.codex;
        if (pathname === "/api/codex-instances" && req.method === "GET") { sendJson(res, 200, instances.list()); return; }
        if (pathname === "/api/codex-instances/refresh" && req.method === "POST") {
          await readJson(req); sendJson(res, 200, await instances.refresh()); return;
        }
        const route = /^\/api\/codex-instances\/([1-9]\d*)\/([^/]+)\/(conversations|messages)$/.exec(pathname);
        if (!route) throw new AttentionError("Unknown endpoint", 404);
        let startedAt: string;
        try { startedAt = decodeURIComponent(route[2]); } catch { throw new AttentionError("Invalid URL encoding"); }
        const target = { codexPid: Number(route[1]), codexStartedAt: startedAt };
        if (!Number.isSafeInteger(target.codexPid) || !Number.isFinite(Date.parse(startedAt))) throw new AttentionError("Invalid Codex instance");
        if (route[3] === "conversations" && req.method === "GET") { sendJson(res, 200, await messages.conversations(target)); return; }
        if (route[3] !== "messages" || req.method !== "POST") throw new AttentionError("Method not allowed", 405);
        const input = await readJson(req);
        const receipt = await receipts.run(user, input.requestId, { action: "instance-message", target, value: input.value }, async () =>
          messages.send(target, input.value?.conversationId, await resolveMessage(input.value?.message, user)));
        sendJson(res, 200, receipt); return;
      }
      if (req.method === "POST" && pathname.startsWith("/api/push/")) {
        const input = await readJson(req);
        if (pathname === "/api/push/subscriptions") sendJson(res, 200, await push.subscribe(user, input.subscription));
        else if (pathname === "/api/push/unsubscribe") { await push.unsubscribe(user, input.endpoint); sendJson(res, 200, { ok: true }); }
        else if (pathname === "/api/push/test") { await push.test(user, input.endpoint); sendJson(res, 200, { ok: true }); }
        else throw new AttentionError("Unknown endpoint", 404);
        return;
      }
      const match = /^\/api\/attention\/([^/]+)\/([^/]+)\/(state|questions|answers|messages|file|approvals)$/.exec(pathname);
      if (!match) throw new AttentionError("Unknown endpoint", 404);
      let source: string, id: string;
      try { source = decodeURIComponent(match[1]); id = decodeURIComponent(match[2]); } catch { throw new AttentionError("Invalid URL encoding"); }
      validateAttentionIdentity(source, id);
      const action = match[3];
      if (action === "file") {
        if (req.method !== "GET") throw new AttentionError("Method not allowed", 405);
        const item = attention.get(source, id);
        if (!item) throw new AttentionError("Attention item no longer exists", 404);
        const query = new URL(req.url!, config.origin).searchParams;
        const file = await attentionFileResponse(item, query.get("target") || "", query.get("download") === "1",
          () => operations.questions(source, id));
        res.writeHead(200, { ...file.headers, "Content-Length": file.body.length }); res.end(file.body); return;
      }
      if (action === "questions" && req.method === "GET") { sendJson(res, 200, await operations.questions(source, id)); return; }
      if (action === "approvals") {
        if (!operations.approval || !operations.approve) throw new AttentionError("Approvals are unavailable", 503);
        if (req.method === "GET") { sendJson(res, 200, operations.approval(source, id)); return; }
        const input = await readJson(req);
        if (input.value !== "accept" && input.value !== "decline") throw new AttentionError("Choose Allow once or Decline");
        const receipt = await receipts.run(user, input.requestId, { source, id, action, value: input.value }, () => operations.approve!(source, id, input.value));
        sendJson(res, 200, receipt); return;
      }
      if (action === "questions" || req.method !== "POST") throw new AttentionError("Method not allowed", 405);
      const input = await readJson(req);
      if (action === "state") { await attention.setState(source, id, input.state); sendJson(res, 200, { ok: true }); return; }
      const receipt = await receipts.run(user, input.requestId, { source, id, action, value: input.value }, async () =>
        action === "answers" ? operations.answer(source, id, input.value) : operations.message(source, id,
          await resolveMessage(input.value, user)));
      sendJson(res, 200, receipt);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error instanceof AttentionError ? error.status : 500,
        { error: error instanceof AttentionError ? error.message : "Request failed; check connection and delivery before retrying" });
      else res.destroy();
    }
  })(); });
  server.on("close", () => { clearInterval(heartbeat); unsubscribe(); unsubscribeInstances?.(); });
  return { server, close() { streams.forEach(res => res.end()); server.close(); } };
}

export async function startAttentionWeb(userData: string, assets: string, attention: AttentionService,
  operations: ReturnType<typeof attentionOperations>, codex?: WebCodexInstances, attachments?: CodexAttachments) {
  const raw = await readWebStore<any>(path.join(userData, "web-config.json"), null);
  if (!raw || raw.enabled === false) return;
  const config = validateWebConfig(raw);
  const receipts = new WebReceipts(path.join(userData, "web-receipts.json")); await receipts.initialize();
  const push = new WebPushService(path.join(userData, "web-push.json"), config.origin, undefined, config.allowedUsers);
  await push.initialize(attention.list());
  const unsubscribe = attention.onChanged(snapshot => push.update(snapshot));
  const web = createAttentionWeb({ config, attention, operations, receipts, push, assets, codex, attachments });
  try { await new Promise<void>((resolve, reject) => { web.server.once("error", reject); web.server.listen(config.port, "127.0.0.1", resolve); }); }
  catch (error) { unsubscribe(); push.close(); web.close(); throw error; }
  console.log(`Attention PWA listening on 127.0.0.1:${config.port}; external origin ${config.origin}`);
  return { ...web, close() { unsubscribe(); push.close(); web.close(); } };
}
