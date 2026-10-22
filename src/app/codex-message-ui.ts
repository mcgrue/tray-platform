import { AttentionBridge, AttentionItem } from "../shared/attention";
import { attentionCodexSession, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";

/** Kept mounted across inbox snapshots so incoming notifications cannot erase a draft. */
export function mountCodexMessageUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem) {
  let item = initial, sending = false, disposed = false;
  const editor = document.createElement("details");
  editor.dataset.codexMessage = "";
  const summary = document.createElement("summary");
  summary.textContent = "Message Codex";
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "Message to this Codex conversation";
  label.style.display = "block";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.maxLength = MAX_CODEX_MESSAGE_LENGTH;
  input.placeholder = "Type a message…";
  label.appendChild(input);
  const hint = document.createElement("p");
  hint.textContent = "Ctrl+Enter to send. Use Done when this item is resolved.";
  const send = document.createElement("button");
  send.type = "submit";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  form.append(label, hint, send, status, error);
  editor.append(summary, form);
  root.appendChild(editor);

  function refresh() {
    editor.hidden = item.source !== "codex" || !bridge.sendAttentionMessage;
    const session = attentionCodexSession(item);
    input.disabled = sending || !session;
    send.disabled = sending || !session || !input.value.trim();
    send.textContent = sending ? "Sending…" : "Send message";
    if (!session) error.textContent = "This item has no Codex session. Use Go to open its conversation.";
  }
  async function submit() {
    if (disposed || sending || send.disabled || !bridge.sendAttentionMessage) return;
    const message = input.value;
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
  editor.addEventListener("toggle", () => { if (editor.open && !sending) input.focus(); });
  refresh();
  return { update(next: AttentionItem) { item = next; refresh(); }, dispose() { disposed = true; } };
}
