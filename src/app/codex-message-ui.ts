import { AttentionBridge, AttentionItem } from "../shared/attention";
import { attentionCodexSession, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";

/** Kept mounted across inbox snapshots so incoming notifications cannot erase a draft. */
export function mountCodexMessageUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem, options: { phone?: boolean } = {}) {
  let item = initial, sending = false, disposed = false;
  let attemptedMessage: string | undefined;
  const completion = item.source === "codex" && /^completion-[a-f0-9]{64}$/.test(item.id);
  const disclosure = completion ? undefined : document.createElement("details");
  const editor = disclosure || document.createElement("section");
  editor.dataset.codexMessage = "";
  if (disclosure) {
    const summary = document.createElement("summary");
    summary.textContent = "Message Codex";
    disclosure.appendChild(summary);
  }
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = completion ? "New instruction" : "Message to this Codex conversation";
  label.style.display = "block";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.maxLength = MAX_CODEX_MESSAGE_LENGTH;
  input.placeholder = completion ? "Tell Codex what to do next…" : "Type a message…";
  label.appendChild(input);
  const hint = document.createElement("p");
  hint.textContent = options.phone ? "Send to this Codex conversation." : completion ? "Ctrl+Enter to send to this conversation." : "Ctrl+Enter to send. Use Done when this item is resolved.";
  const send = document.createElement("button");
  send.type = "submit";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  form.append(label, hint, send, status, error);
  editor.appendChild(form);
  root.appendChild(editor);

  function refresh() {
    editor.hidden = item.source !== "codex" || !bridge.sendAttentionMessage;
    const session = attentionCodexSession(item);
    input.disabled = sending || !session;
    send.disabled = sending || !session || !input.value.trim();
    send.textContent = sending ? "Sending…" : completion ? "Send instruction" : "Send message";
    if (!session) error.textContent = "This item has no Codex session. Use Go to open its conversation.";
  }
  async function submit() {
    if (disposed || sending || send.disabled || !bridge.sendAttentionMessage) return;
    const message = input.value;
    attemptedMessage = message;
    sending = true;
    error.textContent = "";
    status.textContent = "Sending to Codex…";
    refresh();
    try {
      const receipt = await bridge.sendAttentionMessage(item.source, item.id, message);
      if (disposed) return;
      input.value = "";
      status.textContent = receipt.delivery === "steered" ? "Sent to the active Codex turn." : "Sent to Codex as a follow-up.";
    } catch (reason) {
      if (!disposed) {
        status.textContent = "";
        error.textContent = (reason instanceof Error ? reason.message : String(reason))
          .replace(/^Error invoking remote method 'attention-message': (?:Error: )?/, "");
      }
    } finally {
      sending = false;
      if (!disposed) { refresh(); input.focus(); }
    }
  }
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault(); void submit();
    }
  });
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  disclosure?.addEventListener("toggle", () => { if (disclosure.open && !sending) input.focus(); });
  const recovered = bridge.onRecoveredDelivery?.(delivery => {
    if (delivery.source !== item.source || delivery.id !== item.id || delivery.action !== "messages") return;
    if (input.value === attemptedMessage) input.value = "";
    error.textContent = ""; status.textContent = "Delivery confirmed."; refresh();
  });
  refresh();
  return { update(next: AttentionItem) { item = next; refresh(); }, dispose() { disposed = true; recovered?.(); } };
}
