import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { createInterface } from "readline";
import { AttentionItem } from "../shared/attention";
import { legacyCodexIdentity, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexAnswerReceipt, CodexQuestion, hasCodexAsyncQuestion, parseQuestionReplies, questionReplyId } from "../shared/codex-question";
import { CodexMessageService } from "./codex-message-service";

/** Reads only the identified session; never infers question text from the display description. */
export class CodexQuestionService {
  private readonly files = new Map<string, string>();
  private readonly sending = new Set<string>();
  private readonly answered = new Set<string>();

  constructor(private readonly messages: Pick<CodexMessageService, "send">,
    private readonly sessionsRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")) {}

  private identity(item: AttentionItem) {
    const identity = legacyCodexIdentity(item);
    if (!hasCodexAsyncQuestion(item) || !identity) throw new Error("Answer this question in Codex; only async questions can be answered here.");
    const expected = "question-" + createHash("sha256").update(JSON.stringify([identity.session, identity.turn, identity.call])).digest("hex");
    if (item.id !== expected || (item.codexSessionId && item.codexSessionId !== identity.session)) {
      throw new Error("Cannot verify this question's identity. Answer it in Codex.");
    }
    return identity;
  }

  private async findFile(session: string): Promise<string> {
    const cached = this.files.get(session);
    if (cached) return cached;
    const visit = async (directory: string, depth: number): Promise<string | undefined> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const match = entries.find(entry => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${session}.jsonl`));
      if (match) return path.join(directory, match.name);
      if (depth < 3) for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d{2,4}$/.test(entry.name)) continue;
        const found = await visit(path.join(directory, entry.name), depth + 1);
        if (found) return found;
      }
      return undefined;
    };
    const found = await visit(this.sessionsRoot, 0);
    if (!found) throw new Error("The original Codex question is unavailable locally. Answer it in Codex.");
    this.files.set(session, found);
    return found;
  }

  async questions(item: AttentionItem): Promise<CodexQuestion[]> {
    const identity = this.identity(item);
    const file = await this.findFile(identity.session);
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let session: string | undefined, turn: string | undefined, questions: CodexQuestion[] | undefined;
    const replies: ReturnType<typeof parseQuestionReplies> = [];
    try {
      for await (const line of lines) {
        let row: any;
        try { row = JSON.parse(line); } catch { continue; } // A live transcript can end with an incomplete write.
        const payload = row?.payload;
        if (row.type === "session_meta") session = payload?.id;
        if (row.type === "turn_context") turn = payload?.turn_id;
        if (row.type !== "response_item" || !payload) continue;
        const callTurn = payload.internal_chat_message_metadata_passthrough?.turn_id || turn;
        if (payload.type === "function_call" && payload.call_id === identity.call && callTurn === identity.turn &&
          ["request_user_input_async", "functions.request_user_input_async"].includes(payload.name)) {
          if (questions) throw new Error("Ambiguous question identity. Answer it in Codex.");
          const input = JSON.parse(payload.arguments);
          if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 20) throw new Error("Invalid original question.");
          questions = input.questions.map((question: any, index: number) => {
            if (typeof question?.title !== "string" || !question.title.trim() ||
              (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 50 ||
                question.options.some((option: unknown) => typeof option !== "string" || !option.trim())))) throw new Error("Invalid original question.");
            return { index, title: question.title, options: question.options || [], answered: false };
          });
        }
        if (questions && payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
          const text = payload.content.filter((part: any) => part.type === "input_text").map((part: any) => part.text).join("\n");
          replies.push(...parseQuestionReplies(text));
        }
      }
    } finally { lines.close(); stream.destroy(); }
    if (session !== identity.session || !questions) throw new Error("Cannot find the verified original question. Answer it in Codex.");
    return questions.map(question => ({ ...question, answered: this.answered.has(item.id) || replies.some(reply =>
      reply.questionItemId === questionReplyId(identity.call, question.index) && reply.question === question.title) }));
  }

  async answer(item: AttentionItem, value: unknown): Promise<CodexAnswerReceipt> {
    const identity = this.identity(item);
    if (item.state === "done" || this.answered.has(item.id)) throw new Error("This question is already answered. Use Message Codex for a follow-up.");
    if (this.sending.has(item.id)) throw new Error("An answer is already being sent to this question.");
    this.sending.add(item.id);
    try {
      const pending = (await this.questions(item)).filter(question => !question.answered);
      if (!pending.length) throw new Error("This question is already answered in Codex. Use Done to dismiss the Tray item.");
      if (!Array.isArray(value) || value.length !== pending.length || new Set(value.map(answer => answer?.index)).size !== pending.length ||
        value.some(answer => !answer || !pending.some(question => question.index === answer.index) ||
          typeof answer.answer !== "string" || !answer.answer.trim() || answer.answer.length > MAX_CODEX_MESSAGE_LENGTH)) {
        throw new Error("Enter an answer for every unanswered question. Use Reload questions if the question changed.");
      }
      const replies = pending.map(question => ({ questionItemId: questionReplyId(identity.call, question.index),
        question: question.title, answer: value.find(answer => answer.index === question.index).answer }));
      const message = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
      if (message.length > MAX_CODEX_MESSAGE_LENGTH) throw new Error("The questions and answers exceed the message limit. Shorten your answers or answer in Codex.");
      const receipt = await this.messages.send(item, message);
      this.answered.add(item.id);
      return receipt;
    } finally { this.sending.delete(item.id); }
  }
}
