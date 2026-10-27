import { AttentionBridge, AttentionItem } from "../shared/attention";
import { attentionCodexSession, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexMessageDraft, sameMessageDraft } from "../shared/codex-attachments";
import { attachmentMessage, mountCodexAttachmentsUI, newAttachmentDraft } from "./codex-attachments-ui";
import { createCodexMessageInput } from "./codex-message-input";

/** Kept mounted across inbox snapshots so incoming notifications cannot erase a draft. */
export function mountCodexMessageUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem, options: { phone?: boolean } = {}) {
  let item = initial, sending = false, disposed = false;
  let attemptedMessage: CodexMessageDraft | undefined;
  const attachments = newAttachmentDraft();
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
  const input = createCodexMessageInput({ phone: options.phone, label: label.textContent, rows: 3, maxLength: MAX_CODEX_MESSAGE_LENGTH,
    placeholder: completion ? "Tell Codex what to do next…" : "Type a message…" });
  label.appendChild(input.element);
  if (completion) input.element.setAttribute("enterkeyhint", "send");
  const hint = !completion && !options.phone ? document.createElement("p") : undefined;
  if (hint) hint.textContent = "Ctrl+Enter to send. Use Done when this item is resolved.";
  const send = document.createElement("button");
  send.type = "submit";
  if (completion) {
    send.dataset.sendInstruction = "";
    send.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg>';
  }
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const attachmentRoot = document.createElement("section");
  const actions = document.createElement("div"); actions.dataset.composerActions = ""; actions.append(send);
  form.append(label, attachmentRoot);
  if (hint) form.appendChild(hint);
  form.append(actions, status, error);
  editor.appendChild(form);
  root.appendChild(editor);
  const attachmentUI = mountCodexAttachmentsUI(attachmentRoot, form, bridge, () => attachments, refresh);
  actions.prepend(attachmentUI.button);

  function refresh() {
    editor.hidden = item.source !== "codex" || !bridge.sendAttentionMessage;
    const session = attentionCodexSession(item);
    input.disabled = sending || !session;
    send.disabled = sending || !session || (!input.value.trim() && !attachments.files.length);
    attachmentUI.refresh(sending || !session);
    const sendLabel = sending ? "Sending…" : completion ? "Send instruction" : "Send message";
    if (completion) {
      send.title = sendLabel; send.setAttribute("aria-label", sendLabel);
      send.setAttribute("aria-busy", String(sending));
    } else send.textContent = sendLabel;
    if (!session) error.textContent = options.phone ? "This item has no Codex session. Open its conversation on your desktop." : "This item has no Codex session. Use Go to open its conversation.";
  }
  async function submit() {
    if (disposed || sending || send.matches(":disabled") || !bridge.sendAttentionMessage) return;
    const message = attachmentMessage(input.value, attachments);
    attemptedMessage = message;
    sending = true;
    error.textContent = "";
    status.textContent = "Sending to Codex…";
    refresh();
    try {
      await attachmentUI.upload(attachments);
      const receipt = await bridge.sendAttentionMessage(item.source, item.id, message);
      if (disposed) return;
      input.value = ""; attachments.files = [];
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
  input.element.addEventListener("input", refresh);
  let composing = false;
  input.element.addEventListener("compositionstart", () => { composing = true; });
  input.element.addEventListener("compositionend", () => { composing = false; });
  input.element.addEventListener("keydown", event => {
    if (event.key !== "Enter" || composing || event.isComposing || event.keyCode === 229) return;
    if (completion) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) input.insertNewline();
      else if (!event.repeat) void submit();
    } else if (event.ctrlKey || event.metaKey) {
      event.preventDefault(); void submit();
    }
  });
  // Android keyboards can emit an editing action without an Enter keydown.
  input.element.addEventListener("beforeinput", event => {
    const edit = event as InputEvent;
    if (completion && !composing && !edit.isComposing && event.cancelable &&
      (edit.inputType === "insertParagraph" || edit.inputType === "insertLineBreak")) {
      event.preventDefault(); void submit();
    }
  });
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  disclosure?.addEventListener("toggle", () => { if (disclosure.open && !sending) input.focus(); });
  const recovered = bridge.onRecoveredDelivery?.(delivery => {
    if (delivery.source !== item.source || delivery.id !== item.id || delivery.action !== "messages") return;
    if (sameMessageDraft(attemptedMessage, attachmentMessage(input.value, attachments))) { input.value = ""; attachments.files = []; }
    error.textContent = ""; status.textContent = "Delivery confirmed."; refresh();
  });
  refresh();
  return { update(next: AttentionItem) { item = next; refresh(); }, dispose() { disposed = true; recovered?.(); attachmentUI.dispose(); input.dispose(); } };
}
