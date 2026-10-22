import { AttentionBridge, AttentionItem } from "../shared/attention";
import { MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexQuestion, hasCodexAsyncQuestion } from "../shared/codex-question";

export function mountCodexQuestionUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem) {
  let item = initial, disposed = false, loading = false, loaded = false, sending = false, sent = false;
  let questions: CodexQuestion[] = [];
  const fields = new Map<number, HTMLTextAreaElement>();
  const controls: Array<HTMLButtonElement | HTMLTextAreaElement> = [];
  const editor = document.createElement("details");
  editor.dataset.codexQuestion = "";
  const summary = document.createElement("summary");
  summary.textContent = "Answer question";
  const form = document.createElement("form");
  const prompts = document.createElement("div");
  const hint = document.createElement("p");
  hint.textContent = "Answer every open question. Ctrl+Enter submits your answers and resolves this item.";
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
  form.append(prompts, hint, send, retry, status, error);
  editor.append(summary, form);
  root.appendChild(editor);

  const failure = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method 'attention-(?:question|answer)': (?:Error: )?/, "");

  function refresh() {
    editor.hidden = !hasCodexAsyncQuestion(item) || !bridge.getAttentionQuestion || !bridge.answerAttentionQuestion;
    const disabled = loading || sending || sent || item.state === "done";
    controls.forEach(control => { control.disabled = disabled; });
    send.disabled = disabled || !loaded || !fields.size || [...fields.values()].some(field => !field.value.trim());
    send.textContent = sending ? "Sending answers…" : fields.size > 1 ? "Send answers" : "Send answer";
    retry.hidden = loading || sent || item.state === "done" || (loaded && !error.textContent);
    retry.disabled = disabled;
    hint.hidden = !fields.size;
  }

  async function load(force = false) {
    if (disposed || loading || sending || (loaded && !force) || !bridge.getAttentionQuestion) return;
    const drafts = new Map(questions.map(question => [question.index, { title: question.title, value: fields.get(question.index)?.value || "" }]));
    loading = true;
    error.textContent = "";
    status.textContent = "Loading original questions…";
    refresh();
    try {
      questions = await bridge.getAttentionQuestion(item.source, item.id);
      if (disposed) return;
      prompts.replaceChildren(); fields.clear(); controls.length = 0;
      for (const question of questions) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = question.title;
        group.appendChild(legend);
        if (question.answered) {
          const answered = document.createElement("p"); answered.textContent = "Already answered in Codex."; group.appendChild(answered);
        } else {
          const label = document.createElement("label");
          label.textContent = "Your answer";
          const input = document.createElement("textarea");
          input.rows = 3; input.maxLength = MAX_CODEX_MESSAGE_LENGTH; input.dataset.questionIndex = String(question.index);
          if (drafts.get(question.index)?.title === question.title) input.value = drafts.get(question.index)!.value;
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
            choice.addEventListener("click", () => { input.value = option; refresh(); input.focus(); });
            choices.appendChild(choice); controls.push(choice);
          }
          label.appendChild(input); group.append(choices, label);
        }
        prompts.appendChild(group);
      }
      loaded = true;
      status.textContent = fields.size ? "" : "Already answered in Codex. Use Done to dismiss this Tray item.";
      fields.values().next().value?.focus();
    } catch (reason) { if (!disposed) { status.textContent = ""; error.textContent = failure(reason); } }
    finally { loading = false; if (!disposed) refresh(); }
  }

  async function submit() {
    if (disposed || send.disabled || sending || !bridge.answerAttentionQuestion) return;
    sending = true; error.textContent = ""; status.textContent = "Sending answers to Codex…"; refresh();
    try {
      const receipt = await bridge.answerAttentionQuestion(item.source, item.id,
        [...fields.entries()].map(([index, field]) => ({ index, answer: field.value })));
      if (disposed) return;
      sent = true; fields.forEach(field => { field.value = ""; });
      status.textContent = "Answers sent to Codex.";
      error.textContent = receipt.warning || "";
    } catch (reason) { if (!disposed) { status.textContent = ""; error.textContent = failure(reason); } }
    finally { sending = false; if (!disposed) refresh(); }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  retry.addEventListener("click", () => { void load(true); });
  editor.addEventListener("toggle", () => { if (editor.open) void load(); });
  refresh();
  return { update(next: AttentionItem) { item = next; refresh(); }, dispose() { disposed = true; } };
}
