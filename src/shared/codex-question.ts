import { AttentionItem } from "./attention";
import { CodexMessageReceipt, legacyCodexIdentity } from "./codex-message";

export interface CodexQuestion {
  index: number;
  title: string;
  options: string[];
  answered: boolean;
}

export interface CodexQuestionAnswer { index: number; answer: string; }
export interface CodexAnswerReceipt extends CodexMessageReceipt { warning?: string; }

export function hasCodexAsyncQuestion(item: AttentionItem): boolean {
  return item.source === "codex" && Boolean(legacyCodexIdentity(item)) &&
    /^Tool: request_user_input_async\r?$/m.test((item.description || "").split(/\r?\n\r?\n/, 1)[0]);
}

export const questionReplyId = (call: string, index: number): string =>
  JSON.stringify(["request_user_input_async", call, index]);

export function parseQuestionReplies(text: string): Array<{ questionItemId: string; question: string; answer: string }> {
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return [];
  try {
    const value = JSON.parse(match[1]);
    const replies = Array.isArray(value) ? value : [value];
    return replies.length && replies.every(reply => reply && typeof reply.questionItemId === "string" &&
      typeof reply.question === "string" && typeof reply.answer === "string") ? replies : [];
  } catch { return []; }
}
