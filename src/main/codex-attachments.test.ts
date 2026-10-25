import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { CodexAttachments, codexMessageParts } from "./codex-attachments";
import { MAX_CODEX_ATTACHMENT_BYTES } from "../shared/codex-attachments";

let store: CodexAttachments, directory: string;
const upload = (name = "source.ts", bytes = Buffer.from("export const value = 42;\n")) => ({ id: randomUUID(), name, mimeType: "text/plain", base64: bytes.toString("base64") });
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "tray-attachments-")); store = new CodexAttachments(directory); await store.initialize(); });

test("keeps exact bytes in private copies and resolves only uploader-owned opaque IDs", async () => {
  const bytes = Buffer.from("literal café\n\u0000binary"), input = upload("same-name.bin", bytes);
  const attachment = await store.upload(input, "web:owner");
  expect(attachment).toEqual({ id: input.id, name: input.name, size: bytes.length, mimeType: "application/octet-stream", image: false });
  expect(attachment).not.toHaveProperty("path");
  const message: any = await store.message({ text: "Review", attachmentIds: [attachment.id] }, "web:owner");
  expect(await fs.readFile(message.attachments[0].path)).toEqual(bytes);
  expect(path.dirname(message.attachments[0].path)).toBe(directory);
  await expect(store.message({ text: "Review", attachmentIds: [attachment.id] }, "web:other")).rejects.toMatchObject({ status: 403 });
  await expect(store.message({ text: "Review", attachmentIds: [attachment.id] }, "desktop")).rejects.toMatchObject({ status: 403 });
  await expect(store.message({ text: "Forged", attachments: [{ path: "C:/secret" }] }, "web:owner")).rejects.toThrow("Invalid message");
});

test("upload retries are idempotent and retain their ownership across restart", async () => {
  const input = upload(), first = await store.upload(input, "desktop");
  expect(await store.upload(input, "desktop")).toEqual(first);
  await expect(store.upload({ ...input, base64: Buffer.from("changed").toString("base64") }, "desktop")).rejects.toMatchObject({ status: 409 });
  await expect(store.upload(input, "web:other")).rejects.toMatchObject({ status: 409 });
  const restarted = new CodexAttachments(directory); await restarted.initialize();
  expect(await restarted.upload(input, "desktop")).toEqual(first);
  expect(await restarted.message({ text: "", attachmentIds: [input.id] }, "desktop")).toMatchObject({ text: "", attachments: [{ name: "source.ts" }] });
});

test.each(["../secret", "C:\\secret", "alternate:stream", "source\n.ts", "", "a".repeat(201)])("rejects unsafe filename %s without creating files", async name => {
  await expect(store.upload(upload(name), "desktop")).rejects.toThrow("Invalid attachment");
  expect(await fs.readdir(directory)).toEqual([]);
});

test("enforces decoded byte, batch count, total byte, and storage limits", async () => {
  await expect(store.upload(upload("large.bin", Buffer.alloc(MAX_CODEX_ATTACHMENT_BYTES + 1)), "desktop")).rejects.toMatchObject({ status: 413 });
  const large = await store.upload(upload("one.bin", Buffer.alloc(MAX_CODEX_ATTACHMENT_BYTES)), "desktop");
  const second = await store.upload(upload("two.bin", Buffer.alloc(MAX_CODEX_ATTACHMENT_BYTES)), "desktop");
  const small = await store.upload(upload(), "desktop");
  await expect(store.message({ text: "", attachmentIds: [large.id, second.id, small.id] }, "desktop")).rejects.toMatchObject({ status: 413 });
  await expect(store.message({ text: "", attachmentIds: [small.id, small.id] }, "desktop")).rejects.toThrow("Invalid message");
  await expect(store.message({ text: "", attachmentIds: Array.from({ length: 6 }, () => randomUUID()) }, "desktop")).rejects.toThrow("Invalid message");
  const full = new CodexAttachments(directory, undefined, 5); await full.initialize();
  await expect(full.upload(upload(), "desktop")).rejects.toMatchObject({ status: 507 });
});

test("rejects malformed encodings and image impostors", async () => {
  for (const base64 of ["???=", "a===", "abcd=abc", "abc"]) await expect(store.upload({ ...upload(), base64 }, "desktop")).rejects.toThrow("encoding");
  await expect(store.upload({ ...upload("bad.png"), mimeType: "image/png" }, "desktop")).rejects.toThrow("cannot be decoded");
});

test("fails visibly if a retained file was changed", async () => {
  const input = upload(); await store.upload(input, "desktop");
  const message: any = await store.message({ text: "", attachmentIds: [input.id] }, "desktop");
  await fs.writeFile(message.attachments[0].path, "changed");
  await expect(store.message({ text: "", attachmentIds: [input.id] }, "desktop")).rejects.toMatchObject({ status: 409 });
});

test("images get native image input and files retain literal paths and names", () => {
  const file = { id: randomUUID(), name: "source.ts", path: path.resolve(directory, "source.ts"), size: 20, mimeType: "application/octet-stream", image: false };
  const image = { ...file, id: randomUUID(), name: "screen.png", path: path.resolve(directory, "screen.png"), mimeType: "image/png", image: true };
  const parts = codexMessageParts({ text: "", attachments: [file, image] });
  expect(parts.input).toHaveLength(2); expect(parts.input[1]).toEqual({ type: "localImage", path: image.path });
  expect(parts.input[0]).toMatchObject({ type: "text", text: expect.stringContaining(JSON.stringify({ name: file.name, path: file.path, image: false })) });
  expect(parts.fileAttachments).toEqual([{ label: file.name, path: file.path, fsPath: file.path }]);
  expect(parts.imageAttachments[0]).toMatchObject({ localPath: image.path, filename: image.name });
  expect(codexMessageParts("literal").input).toEqual([{ type: "text", text: "literal", text_elements: [] }]);
});
