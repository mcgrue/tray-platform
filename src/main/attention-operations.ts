import { AttentionService, AttentionError } from "./attention-service";
import { CodexMessageService } from "./codex-message-service";
import { CodexQuestionService } from "./codex-question-service";
import { CodexApprovalService } from "./codex-approval-service";
import { CodexTurnOptions } from "../shared/codex-turn-controls";

/** Transport authorization stays in IPC/HTTP; delivery semantics are shared. */
export function attentionOperations(attention: AttentionService, messages: Pick<CodexMessageService, "send"> & Partial<Pick<CodexMessageService, "turnSettings">>,
  questions: Pick<CodexQuestionService, "questions" | "answer">, approvals?: Pick<CodexApprovalService, "get" | "decide">) {
  const find = (source: string, id: string) => {
    const item = attention.get(source, id);
    if (!item) throw new AttentionError("Attention item no longer exists", 404);
    return item;
  };
  return {
    ...(approvals ? {
      approval: (source: string, id: string) => approvals.get(source, id),
      approve: (source: string, id: string, decision: unknown) => approvals.decide(source, id, decision),
    } : {}),
    message: (source: string, id: string, text: unknown, options?: CodexTurnOptions) => options
      ? messages.send(find(source, id), text, undefined, options) : messages.send(find(source, id), text),
    turnSettings: (source: string, id: string) => {
      if (!messages.turnSettings) throw new AttentionError("Codex turn settings are unavailable", 503);
      return messages.turnSettings(find(source, id));
    },
    questions: (source: string, id: string) => questions.questions(find(source, id)),
    async answer(source: string, id: string, answers: unknown) {
      const receipt = await questions.answer(find(source, id), answers);
      if (receipt.remainingQuestions > 0) return receipt;
      try { await attention.setState(source, id, "done"); }
      catch { return { ...receipt, warning: "Answers were sent, but the Tray item could not be marked Done. Use Done when storage is available; do not resend." }; }
      return receipt;
    },
  };
}
