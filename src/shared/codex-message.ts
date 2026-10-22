import { AttentionItem } from "./attention";

export const MAX_CODEX_MESSAGE_LENGTH = 20000;
export const isCodexSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

/** Older hook versions embedded the identity in the fixed description header. */
export function legacyCodexIdentity(item: AttentionItem): { session: string; turn: string; call: string } | undefined {
  const header = /^Project: [^\r\n]+\r?\nSession: ([^\r\n]+)\r?\nTurn: ([^\r\n]+)\r?\nCall: ([^\r\n]+)\r?\nTool: request_user_input(?:_async)?\r?\n\r?\n/.exec(item.description || "");
  return header && isCodexSessionId(header[1]) ? { session: header[1], turn: header[2], call: header[3] } : undefined;
}

export function attentionCodexSession(item: AttentionItem): string | undefined {
  if (item.source !== "codex") return undefined;
  return isCodexSessionId(item.codexSessionId) ? item.codexSessionId : legacyCodexIdentity(item)?.session;
}

export interface CodexMessageReceipt { sessionId: string; turnId: string; delivery: "steered" | "started"; }
