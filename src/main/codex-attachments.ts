import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { AttentionError } from "./attention-service";
import { readWebStore, writeWebStore } from "./web-store";
import { CodexAttachment, MAX_CODEX_ATTACHMENTS, MAX_CODEX_ATTACHMENT_BYTES, MAX_CODEX_ATTACHMENTS_BYTES } from "../shared/codex-attachments";
import { MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";

interface RecordEntry extends CodexAttachment { owner: string; sha256: string; filename: string; }
export interface StoredCodexAttachment extends CodexAttachment { path: string; }
export type CodexMessage = string | { text: string; attachments: StoredCodexAttachment[] };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const publicAttachment = ({ id, name, size, mimeType, image }: CodexAttachment): CodexAttachment => ({ id, name, size, mimeType, image });
function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

/** Private immutable copies. Only uploader-owned opaque IDs cross renderer/HTTP boundaries. */
export class CodexAttachments {
  private records: Record<string, RecordEntry> = Object.create(null);
  private queue: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  constructor(private directory: string, private verifyImage?: (bytes: Buffer) => boolean, private maxStorage = 512 * 1024 * 1024) {}
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    const store = await readWebStore(path.join(this.directory, "index.json"), { version: 1, records: {} as Record<string, RecordEntry> });
    if (store.version !== 1 || !store.records || Array.isArray(store.records)) throw new Error("Invalid attachment store");
    for (const [id, record] of Object.entries(store.records)) {
      if (!idPattern.test(id) || record?.id !== id || typeof record.owner !== "string" || typeof record.name !== "string" ||
        typeof record.filename !== "string" || !new RegExp(`^${id}(?:\\.[a-z0-9]{1,12})?$`).test(record.filename) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Invalid attachment record");
    }
    this.records = Object.assign(Object.create(null), store.records);
    // Include orphaned writes in the quota. Never erase files on startup or after uncertain sends.
    for (const name of await fs.readdir(this.directory)) { const stat = await fs.lstat(path.join(this.directory, name)); if (stat.isFile()) this.bytes += stat.size; }
  }
  upload(value: any, owner: string): Promise<CodexAttachment> {
    const work = this.queue.then(async () => {
      if (!value || !idPattern.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 ||
        /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value.name) || typeof value.base64 !== "string") throw new AttentionError("Invalid attachment");
      if (value.base64.length > Math.ceil(MAX_CODEX_ATTACHMENT_BYTES / 3) * 4) throw new AttentionError("Each attachment must be 10 MiB or smaller", 413);
      if (value.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(value.base64) || !/^[^=]*(?:={1,2})?$/.test(value.base64)) throw new AttentionError("Invalid attachment encoding");
      const bytes = Buffer.from(value.base64, "base64");
      if (bytes.length > MAX_CODEX_ATTACHMENT_BYTES) throw new AttentionError("Each attachment must be 10 MiB or smaller", 413);
      const detected = imageType(bytes), declaredImage = /^image\/(png|jpeg|gif|webp)$/i.test(String(value.mimeType));
      if ((declaredImage && !detected) || (detected && this.verifyImage && !this.verifyImage(bytes))) throw new AttentionError("The image cannot be decoded. Choose another image.");
      const sha256 = digest(bytes), existing = this.records[value.id];
      if (existing) {
        if (existing.owner !== owner || existing.sha256 !== sha256 || existing.name !== value.name) throw new AttentionError("Attachment ID already used", 409);
        return publicAttachment(existing);
      }
      if (this.bytes + bytes.length > this.maxStorage || Object.keys(this.records).length >= 5000) throw new AttentionError("Attachment storage is full. Manage retained files on the desktop before uploading more.", 507);
      const extension = path.extname(value.name).toLowerCase();
      const filename = value.id + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "");
      await fs.writeFile(path.join(this.directory, filename), bytes, { flag: "wx", mode: 0o600 }); this.bytes += bytes.length;
      const record: RecordEntry = { id: value.id, owner, name: value.name, size: bytes.length, sha256, filename,
        mimeType: detected || "application/octet-stream", image: !!detected };
      const records = { ...this.records, [record.id]: record };
      await writeWebStore(path.join(this.directory, "index.json"), { version: 1, records }); this.records = records;
      return publicAttachment(record);
    });
    this.queue = work.catch(() => {}); return work;
  }
  async message(value: unknown, owner: string): Promise<CodexMessage> {
    if (typeof value === "string") { validateCodexMessage(value); return value; }
    const input = value as any;
    if (!input || typeof input.text !== "string" || !Array.isArray(input.attachmentIds) || input.attachmentIds.length > MAX_CODEX_ATTACHMENTS ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length) throw new AttentionError("Invalid message attachments");
    const attachments: StoredCodexAttachment[] = [];
    let total = 0;
    for (const id of input.attachmentIds) {
      const record = typeof id === "string" && idPattern.test(id) ? this.records[id] : undefined;
      if (!record || record.owner !== owner) throw new AttentionError("Attachment is unavailable for this sender. Attach the file again.", 403);
      total += record.size; if (total > MAX_CODEX_ATTACHMENTS_BYTES) throw new AttentionError("Attachments must total 20 MiB or less", 413);
      const file = path.join(this.directory, record.filename), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== record.size || digest(await fs.readFile(file)) !== record.sha256) throw new AttentionError("An attached file changed or is missing. Attach it again.", 409);
      attachments.push({ ...publicAttachment(record), path: file });
    }
    const message = attachments.length ? { text: input.text, attachments } : input.text;
    validateCodexMessage(message); return message;
  }
}

export function validateCodexMessage(value: unknown): asserts value is CodexMessage {
  const text = typeof value === "string" ? value : (value as any)?.text;
  const attachments = typeof value === "object" && value ? (value as any).attachments : [];
  if (typeof text !== "string" || text.length > MAX_CODEX_MESSAGE_LENGTH || (!text.trim() && !attachments?.length) ||
    !Array.isArray(attachments) || attachments.length > MAX_CODEX_ATTACHMENTS || attachments.some(row => typeof row?.path !== "string" || !path.isAbsolute(row.path))) {
    throw new Error(`Enter a message of up to ${MAX_CODEX_MESSAGE_LENGTH} characters or attach a file.`);
  }
}
export function codexMessageParts(message: CodexMessage) {
  validateCodexMessage(message);
  const text = typeof message === "string" ? message : message.text, files = typeof message === "string" ? [] : message.attachments;
  const context = files.length ? "\n\nAttached local files:\n" + files.map(file => JSON.stringify({ name: file.name, path: file.path, image: file.image })).join("\n") : "";
  const input: Array<{ type: "text"; text: string; text_elements: never[] } | { type: "localImage"; path: string }> = [{ type: "text", text: text + context, text_elements: [] }];
  for (const file of files) if (file.image) input.push({ type: "localImage", path: file.path });
  const attachments = files.map(file => ({ label: file.name, path: file.path, fsPath: file.path, ...(file.image ? { isImageAttachment: true } : {}) }));
  return { text, input, attachments, fileAttachments: attachments.filter(file => !file.isImageAttachment),
    imageAttachments: files.filter(file => file.image).map(file => ({ id: file.id, filename: file.name, src: file.path, localPath: file.path })) };
}
