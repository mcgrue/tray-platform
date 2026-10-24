import http from "http";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AttentionService } from "./attention-service";
import { createAttentionWeb } from "./attention-web";
import { WebReceipts } from "./web-receipts";
import { WebPushService } from "./web-push-service";
import { attentionFileHref, localFileHref, localFileLink } from "../shared/attention-link";
import { attentionFileResponse, MAX_ATTENTION_FILE_BYTES } from "./attention-files";
import { createHash } from "crypto";

let attention: AttentionService, web: ReturnType<typeof createAttentionWeb>, push: WebPushService, port: number;
let root: string, filename: string, target: string;
const content = "# Manual checks\n\n<script>window.pwned = true</script>\nNamed links & raw content\n";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tray-linked-files-"));
  filename = path.join(root, "Manual checks.md");
  await fs.writeFile(filename, content);
  target = localFileHref(localFileLink(filename)!);
  attention = new AttentionService(path.join(root, "attention.json")); await attention.initialize();
  await attention.upsert("codex", "item", { title: "Done", description: `[manual checks](<${filename}>)` });
  const receipts = new WebReceipts(path.join(root, "receipts.json")); await receipts.initialize();
  push = new WebPushService(path.join(root, "push.json"), "https://fixture.ts.net", async () => {}, ["owner"]);
  await push.initialize(attention.list());
  web = createAttentionWeb({ config: { origin: "https://fixture.ts.net", allowedUsers: ["owner"], port: 0 }, attention,
    receipts, push, assets: path.join(process.cwd(), "src/web"), operations: { questions: async () => [] } as any });
  await new Promise<void>(resolve => web.server.listen(0, "127.0.0.1", resolve)); port = (web.server.address() as any).port;
});
afterEach(async () => {
  attention.close(); push.close(); const closed = new Promise<void>(resolve => web.server.once("close", resolve)); web.close(); await closed;
});
function request(url = attentionFileHref({ source: "codex", id: "item" }, target), headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: url, headers: { Host: "fixture.ts.net", "Tailscale-User-Login": "owner", ...headers } }, res => {
      let body = ""; res.on("data", value => body += value); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }).on("error", reject);
  });
}

test("authenticated clicks view escaped text and can download the original file", async () => {
  const response = await request();
  expect(response.status).toBe(200); expect(response.body).toContain("Manual checks.md");
  expect(response.body).toContain("&lt;script&gt;window.pwned = true&lt;/script&gt;");
  expect(response.body).not.toContain("<script>"); expect(response.body).toContain("download=1");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-security-policy"]).toContain("sandbox");
  const download = await request(attentionFileHref({ source: "codex", id: "item" }, target) + "&download=1");
  expect(download.status).toBe(200); expect(download.body).toBe(content);
  expect(download.headers["content-disposition"]).toContain("attachment; filename*=UTF-8''Manual%20checks.md");
  expect(download.headers["content-type"]).toBe("application/octet-stream");
});

test("files require authentication and an actual link belonging to that item", async () => {
  expect((await request(undefined, { "Tailscale-User-Login": "" })).status).toBe(403);
  expect((await request(undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  const secret = path.join(root, "secret.txt"); await fs.writeFile(secret, "private");
  expect((await request(attentionFileHref({ source: "codex", id: "item" }, secret))).status).toBe(403);
  expect((await request(attentionFileHref({ source: "codex", id: "missing" }, target))).status).toBe(404);
  await attention.upsert("codex", "item", { title: "Done", description: `\u0060[code](<${filename}>)\u0060` });
  expect((await request()).status).toBe(403);
});

test("missing files and directories return useful errors without exposing a filesystem browser", async () => {
  const missing = path.join(root, "missing.md");
  await attention.upsert("codex", "item", { title: "Done", description: `[missing](<${missing}>)\n[directory](<${root}>)` });
  expect((await request(attentionFileHref({ source: "codex", id: "item" }, missing))).status).toBe(404);
  expect((await request(attentionFileHref({ source: "codex", id: "item" }, root))).status).toBe(400);
});

test("binary files are attachments and line links have stable preview anchors", async () => {
  const binary = path.join(root, "archive.bin"); await fs.writeFile(binary, Buffer.from([0, 1, 2, 3]));
  await attention.upsert("codex", "item", { title: "Done", description: `[binary](<${binary}>)\n[line](<${filename}:3>)` });
  const attachment = await request(attentionFileHref({ source: "codex", id: "item" }, binary));
  expect(attachment.status).toBe(200); expect(attachment.headers["content-disposition"]).toContain("attachment;");
  const line = await request(attentionFileHref({ source: "codex", id: "item" }, filename + ":3").split("#")[0]);
  expect(line.status).toBe(200); expect(line.body).toContain('id="L3"');
});

test("question-only links come from verified prompts and cannot authorize other files", async () => {
  const identity = ["session", "turn", "call"];
  const id = "question-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  await attention.upsert("codex", id, { title: "Question", description:
    "Project: fixture\nSession: session\nTurn: turn\nCall: call\nTool: request_user_input_async\n\nA preview without the file link." });
  const item = attention.get("codex", id)!;
  const questions = jest.fn(async () => [{ index: 0, title: `[notes](<${filename}>)`, options: [], answered: false }]);
  expect((await attentionFileResponse(item, target, false, questions)).body.toString()).toContain("Manual checks.md");
  expect(questions).toHaveBeenCalledTimes(1);
  await expect(attentionFileResponse(item, target, false, async () => [])).rejects.toMatchObject({ status: 403 });
  await expect(attentionFileResponse(item, path.join(root, "unlisted.txt"), false, questions)).rejects.toMatchObject({ status: 403 });
});

test("oversize files are rejected before reading and larger text files download", async () => {
  const large = path.join(root, "large.txt");
  await fs.writeFile(large, "x");
  await attention.upsert("codex", "item", { title: "Large file", description: `[large](<${large}>)` });
  await fs.truncate(large, MAX_ATTENTION_FILE_BYTES + 1);
  expect((await request(attentionFileHref({ source: "codex", id: "item" }, large))).status).toBe(413);
  await fs.writeFile(large, "x".repeat(2 * 1024 * 1024 + 1));
  const response = await request(attentionFileHref({ source: "codex", id: "item" }, large));
  expect(response.status).toBe(200); expect(response.headers["content-disposition"]).toContain("attachment;");
});
