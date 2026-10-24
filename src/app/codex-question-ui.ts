import { AttentionBridge, AttentionItem } from "../shared/attention";
import { MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexQuestion, CodexQuestionAnswer, hasCodexAsyncQuestion } from "../shared/codex-question";
import { renderAttentionMarkdown } from "./attention-markdown";

export function mountCodexQuestionUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem, onLoaded?: () => void) {
  let item = initial, disposed = false, loading = false, loaded = false, sending = false;
  let questions: CodexQuestion[] = [];
  const fields = new Map<number, HTMLTextAreaElement>();
  const controls: Array<HTMLButtonElement | HTMLTextAreaElement> = [];
  const editor = document.createElement("details");
  editor.dataset.codexQuestion = "";
  editor.open = initial.state !== "done";
  const summary = document.createElement("summary");
  summary.textContent = "Answer question";
  const form = document.createElement("form");
  const prompts = document.createElement("div");
  const send = document.createElement("button");
  send.type = "submit";
  send.dataset.submitAnswer = "";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Reload questions";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  form.append(prompts, send, retry, status, error);
  editor.append(summary, form);
  root.appendChild(editor);

  const failure = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method 'attention-(?:question|answer)': (?:Error: )?/, "");

  function refresh() {
    editor.hidden = !hasCodexAsyncQuestion(item) || !bridge.getAttentionQuestion || !bridge.answerAttentionQuestion;
    const disabled = loading || sending || item.state === "done";
    controls.forEach(control => { control.disabled = disabled; });
    send.disabled = disabled || !loaded || ![...fields.values()].some(field => field.value.trim());
    send.hidden = loaded && !fields.size;
    send.textContent = sending ? "Sending answers…" : fields.size > 1 ? "Send answers" : "Send answer";
    retry.hidden = loading || item.state === "done" || (loaded && !error.textContent);
    retry.disabled = disabled;
  }

  function renderQuestions() {
    const drafts = new Map([...fields].map(([index, field]) => [index, field.value]));
    prompts.replaceChildren(); fields.clear(); controls.length = 0;
    for (const question of questions) {
      const group = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = `Question ${question.index + 1}`;
      const prompt = document.createElement("div");
      prompt.className = "attention-markdown";
      prompt.dataset.codexQuestionPrompt = "";
      prompt.innerHTML = renderAttentionMarkdown(question.title);
      group.append(legend, prompt);
      if (question.answered) {
        const answered = document.createElement("p"); answered.textContent = "Answered in Codex."; group.appendChild(answered);
      } else {
        const label = document.createElement("label");
        label.textContent = "Your answer";
        const input = document.createElement("textarea");
        input.rows = 3; input.maxLength = MAX_CODEX_MESSAGE_LENGTH; input.dataset.questionIndex = String(question.index);
        input.value = drafts.get(question.index) || "";
        input.addEventListener("input", refresh);
        input.addEventListener("keydown", event => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void submit(); }
        });
        fields.set(question.index, input); controls.push(input);
        const choices = document.createElement("div");
        choices.style.display = "flex"; choices.style.flexWrap = "wrap"; choices.style.gap = "6px";
        for (const option of question.options) {
          const choice = document.createElement("button");
          choice.type = "button"; choice.textContent = option;
          choice.addEventListener("click", () => { void submit([{ index: question.index, answer: option }]); });
          choices.appendChild(choice); controls.push(choice);
        }
        label.appendChild(input); group.append(choices, label);
      }
      prompts.appendChild(group);
    }
  }

  async function load(force = false) {
    if (disposed || editor.hidden || loading || sending || (loaded && !force) || !bridge.getAttentionQuestion) return;
    const drafts = new Map(questions.map(question => [question.index, { title: question.title, value: fields.get(question.index)?.value || "" }]));
    loading = true;
    error.textContent = "";
    status.textContent = "Loading original questions…";
    refresh();
    try {
      const next = await bridge.getAttentionQuestion(item.source, item.id);
      if (disposed) return;
      questions = next;
      // Do not carry a draft into a different question after an explicit reload.
      for (const question of questions) if (drafts.get(question.index)?.title !== question.title) fields.delete(question.index);
      renderQuestions();
      loaded = true;
      status.textContent = fields.size ? "" : "Already answered in Codex. Use Done to dismiss this Tray item.";
      onLoaded?.();
    } catch (reason) { if (!disposed) { status.textContent = ""; error.textContent = failure(reason); } }
    finally { loading = false; if (!disposed) refresh(); }
  }

  async function submit(selected?: CodexQuestionAnswer[]) {
    if (disposed || loading || sending || item.state === "done" || !loaded || !bridge.answerAttentionQuestion) return;
    const answers = selected || [...fields].filter(([, field]) => field.value.trim()).map(([index, field]) => ({ index, answer: field.value }));
    if (!answers.length || answers.some(answer => !fields.has(answer.index))) return;
    sending = true; error.textContent = ""; status.textContent = "Sending answers to Codex…"; refresh();
    try {
      const receipt = await bridge.answerAttentionQuestion(item.source, item.id, answers);
      if (disposed) return;
      questions.forEach(question => { if (receipt.remainingQuestions === 0 || answers.some(answer => answer.index === question.index)) question.answered = true; });
      renderQuestions();
      status.textContent = "Answers sent to Codex.";
      error.textContent = receipt.warning || "";
    } catch (reason) { if (!disposed) { status.textContent = ""; error.textContent = failure(reason); } }
    finally { sending = false; if (!disposed) refresh(); }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  retry.addEventListener("click", () => { void load(true); });
  editor.addEventListener("toggle", () => { if (editor.open) void load(); });
  const recovered = bridge.onRecoveredDelivery?.(delivery => {
    if (delivery.source !== item.source || delivery.id !== item.id || delivery.action !== "answers") return;
    error.textContent = ""; void load(true);
  });
  refresh();
  if (!editor.hidden && editor.open) void load();
  return { update(next: AttentionItem) { item = next; refresh(); }, dispose() { disposed = true; recovered?.(); } };
}
