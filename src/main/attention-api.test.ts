import http = require("http");
import { promises as fs } from "fs";
import path = require("path");
import os = require("os");
import { createAttentionApi, isLoopback, MAX_ATTENTION_BODY_BYTES } from "./attention-api";
import { AttentionService } from "./attention-service";

let service: AttentionService;
let server: http.Server;
let port: number;
const windows = [{ kind: "window" as const, hwnd: "123", pid: 42, processStartedAt: "2026-10-16T00:00:00Z", title: "Editor" }];
beforeEach(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-attention-http-"));
  service = new AttentionService(path.join(directory, "attention.json")); await service.initialize();
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => windows } });
  server = http.createServer((req, res) => { api(req, res).then(handled => { if (!handled) { res.writeHead(200); res.end("legacy"); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});
afterEach(async () => { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

function request(url: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text }); });
    });
    req.on("error", reject); req.end(body);
  });
}

test("ephemeral HTTP server creates, lists, updates state, discovers windows, and preserves legacy paths", async () => {
  const created = await request("/api/attention/build/job%201", "PUT", JSON.stringify({ title: "Done", sound: "fanfare" }));
  expect(created.status).toBe(200); expect(created.body.item.id).toBe("job 1");
  expect((await request("/api/attention")).body.items).toHaveLength(1);
  expect((await request("/api/attention/build/job%201/state", "POST", '{"state":"done"}')).status).toBe(200);
  expect((await request("/api/attention/build/job%201/state", "POST", '{"state":"snoozed","minutes":5}')).status).toBe(400);
  expect(service.get("build", "job 1").state).toBe("done");
  expect((await request("/api/attention/build/job%201", "PUT", '{"title":"Retry"}')).body.item.state).toBe("done");
  expect((await request("/api/windows")).body.windows).toEqual(windows);
  expect(await request("/DOCTEST_ALL_TESTS_PASS")).toEqual({ status: 200, body: "legacy" });
});

test("ends malformed, oversized, unsupported-method, missing, and failed-state requests", async () => {
  expect((await request("/api/attention/a/b", "PUT", "{oops")).status).toBe(400);
  expect((await request("/api/attention/a/b", "PUT", "[]")).status).toBe(400);
  expect((await request("/api/attention/a/b", "PUT", JSON.stringify({ title: "x".repeat(MAX_ATTENTION_BODY_BYTES) }))).status).toBe(413);
  expect((await request("/api/attention/a/b", "DELETE")).status).toBe(405);
  expect((await request("/api/unknown")).status).toBe(404);
  expect((await request("/api/attention/a/%ZZ", "PUT", '{"title":"Bad"}')).status).toBe(400);
  expect((await request("/api/attention/a/missing/state", "POST", '{"state":"done"}')).status).toBe(404);
  expect((await request("/api/attention", "GET", undefined, { Origin: "https://untrusted.example" })).status).toBe(403);
});

test.each(["127.0.0.1", "127.2.3.4", "::1", "::ffff:127.0.0.1"])("allows loopback identity %s", address => expect(isLoopback(address)).toBe(true));

test("the generic attention API cannot forge or replace runtime approval cards", async () => {
  expect((await request("/api/attention/codex-approval/forged", "PUT", '{"title":"Forged"}')).status).toBe(403);
  expect((await request("/api/attention/other/forged", "PUT", '{"title":"Forged","approval":{}}')).status).toBe(403);
  await service.upsert("codex-approval", "real", { title: "Runtime request" });
  expect((await request("/api/attention/codex-approval/real", "PUT", '{"title":"Overwritten"}')).status).toBe(403);
  expect(service.get("codex-approval", "real")?.title).toBe("Runtime request");
  expect(service.get("other", "forged")).toBeUndefined();
});
test.each([undefined, "192.168.1.5", "::ffff:192.168.1.5", "127.0.0.1.evil", "localhost"])("rejects non-loopback identity %s", address => expect(isLoopback(address)).toBe(false));

test("rejects a non-loopback socket before touching the service", async () => {
  const api = createAttentionApi({ attention: service, desktop: { listWindows: async () => windows } });
  const res = { writableEnded: false, destroyed: false, writeHead: jest.fn(), end: jest.fn() };
  await expect(api({ url: "/api/attention", method: "GET", socket: { remoteAddress: "192.168.0.1" }, headers: {} } as any, res as any)).resolves.toBe(true);
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything()); expect(res.end).toHaveBeenCalledTimes(1);
});
