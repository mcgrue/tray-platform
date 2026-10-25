export const MAX_CODEX_ATTACHMENTS = 5;
export const MAX_CODEX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
export const MAX_CODEX_UPLOAD_BODY = Math.ceil(MAX_CODEX_ATTACHMENT_BYTES / 3) * 4 + 4096;
export interface CodexAttachment { id: string; name: string; size: number; mimeType: string; image: boolean; }
export interface CodexAttachmentUpload { id: string; name: string; mimeType: string; base64: string; }
export type CodexMessageDraft = string | { text: string; attachmentIds: string[] };
export interface CodexAttachmentsBridge { uploadCodexAttachment?(upload: CodexAttachmentUpload): Promise<CodexAttachment>; }
export function sameMessageDraft(a: CodexMessageDraft | undefined, b: CodexMessageDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
