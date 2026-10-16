import http = require("http");
import { promises as fs } from "fs";
import path = require("path");
import os = require("os");
import { BookmarkService } from "./bookmark-service";
import { createBookmarkApi } from "./bookmark-api";
import { MAX_ATTENTION_BODY_BYTES } from "./attention-api";

let service: BookmarkService;
let server: http.Server;
let port: number;
beforeEach(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-bookmark-http-"));
  service = new BookmarkService(path.join(directory, "bookmarks.json"), { attentionExists: (source, id) => source === "build" && id === "done" });
  await service.initialize();
  const api = createBookmarkApi({ bookmarks: service });
  server = http.createServer((req, res) => { api(req, res).then(handled => { if (!handled) { res.writeHead(200); res.end("other-handler"); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});
afterEach(async () => { service.close(); jest.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); });

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

test("creates and lists bookmarks with encoded identities and preserves metadata/human notes on robot retries", async () => {
  const created = await request("/api/bookmarks/robot/job%201", "PUT", JSON.stringify({ title: "Resume", attention: { source: "build", id: "done" }, destination: { kind: "url", url: "https://example.org" }, robotHint: "Passed" }));
  expect(created.status).toBe(200); expect(created.body.bookmark.id).toBe("job 1");
  await service.saveHuman("robot", "job 1", { title: "Resume", humanNote: "Inspect inventory" });
  const updated = await request("/api/bookmarks/robot/job%201", "PUT", '{"robotHint":"New hint"}');
  expect(updated.status).toBe(200);
  expect(updated.body.bookmark).toMatchObject({ humanNote: "Inspect inventory", robotHint: "New hint", attention: { source: "build", id: "done" }, destination: { kind: "url", url: "https://example.org" } });
  expect((await request("/api/bookmarks?project=whatever")).body.bookmarks).toHaveLength(1);
  expect((await request("/api/bookmarks/robot/job%201", "PUT", '{"humanNote":"attack"}')).status).toBe(400);
  expect(service.get("robot", "job 1")!.humanNote).toBe("Inspect inventory");
});

test("falls through every unrelated route, including similarly prefixed names", async () => {
  for (const url of ["/api/attention", "/api/windows", "/DOCTEST_ALL_TESTS_PASS", "/api/bookmarks-other"]) {
    expect(await request(url)).toEqual({ status: 200, body: "other-handler" });
  }
});

test("ends malformed, oversized, missing, unsupported-method, and missing-association requests", async () => {
  expect((await request("/api/bookmarks/a/b", "PUT", "{oops")).status).toBe(400);
  expect((await request("/api/bookmarks/a/b", "PUT", "[]")).status).toBe(400);
  expect((await request("/api/bookmarks/a/b", "PUT", JSON.stringify({ title: "x".repeat(MAX_ATTENTION_BODY_BYTES) }))).status).toBe(413);
  expect((await request("/api/bookmarks", "POST", "{}")).status).toBe(405);
  expect((await request("/api/bookmarks/a/b", "DELETE")).status).toBe(405);
  expect((await request("/api/bookmarks/a")).status).toBe(404);
  expect((await request("/api/bookmarks/a/%ZZ", "PUT", '{"title":"Bad"}')).status).toBe(400);
  expect((await request("/api/bookmarks/a/b", "PUT", '{"title":"No association"}')).status).toBe(400);
  expect((await request("/api/bookmarks/a/b", "PUT", '{"title":"Missing task","attention":{"source":"a","id":"missing"}}')).status).toBe(404);
});

test("rejects browser origins and non-loopback sockets before touching the service", async () => {
  expect((await request("/api/bookmarks", "GET", undefined, { Origin: "https://untrusted.example" })).status).toBe(403);
  const list = jest.spyOn(service, "list");
  const res = { writableEnded: false, destroyed: false, writeHead: jest.fn(), end: jest.fn() };
  const api = createBookmarkApi({ bookmarks: service });
  await expect(api({ url: "/api/bookmarks", method: "GET", socket: { remoteAddress: "192.168.0.1" }, headers: {} } as any, res as any)).resolves.toBe(true);
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  expect(list).not.toHaveBeenCalled(); expect(res.end).toHaveBeenCalledTimes(1);
});

test("write failures return a completed error response and later calls recover", async () => {
  jest.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk denied"));
  const input = '{"title":"Task","project":"P"}';
  expect(await request("/api/bookmarks/a/b", "PUT", input)).toEqual({ status: 500, body: { error: "Bookmark request failed" } });
  expect((await request("/api/bookmarks")).body.bookmarks).toHaveLength(0);
  expect((await request("/api/bookmarks/a/b", "PUT", input)).status).toBe(200);
});
