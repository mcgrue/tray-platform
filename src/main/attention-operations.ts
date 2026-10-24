import { AttentionService, AttentionError } from "./attention-service";
import { CodexMessageService } from "./codex-message-service";
import { CodexQuestionService } from "./codex-question-service";

/** Transport authorization stays in IPC/HTTP; delivery semantics are shared. */
export function attentionOperations(attention: AttentionService, messages: Pick<CodexMessageService, "send">,
  questions: Pick<CodexQuestionService, "questions" | "answer">) {
  const find = (source: string, id: string) => {
    const item = attention.get(source, id);
    if (!item) throw new AttentionError("Attention item no longer exists", 404);
    return item;
  };
  return {
    message: (source: string, id: string, text: unknown) => messages.send(find(source, id), text),
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
