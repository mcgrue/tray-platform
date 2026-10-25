import { CodexInstance, CodexInstanceConversation, CodexInstancesBridge, CodexInstancesSnapshot } from "../shared/codex-instances";
import { CodexMessageReceipt, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { sameMessageDraft } from "../shared/codex-attachments";
import { AttachmentDraft, attachmentMessage, mountCodexAttachmentsUI, newAttachmentDraft } from "./codex-attachments-ui";

interface Draft {
  instance: CodexInstance; conversations: CodexInstanceConversation[]; conversationId: string; text: string; attachments: AttachmentDraft;
  loading: boolean; sending: boolean; sendRevision: number; available: boolean; loaded: boolean; selectionMissing: boolean; status: string; error: string;
}
const identity = (row: CodexInstance) => JSON.stringify([row.codexPid, row.codexStartedAt]);
const target = (row: CodexInstance) => ({ codexPid: row.codexPid, codexStartedAt: row.codexStartedAt });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method 'codex-instance-(?:conversations|message)': (?:Error: )?/, "");

/** A stable editor outside the table; sorting and activity snapshots cannot erase drafts. */
export function mountCodexInstanceComposer(root: HTMLElement, bridge: CodexInstancesBridge) {
  const drafts = new Map<string, Draft>();
  let active: Draft | undefined, disposed = false;
  root.dataset.codexInstanceComposer = ""; root.hidden = true;
  const heading = document.createElement("h3"); heading.textContent = "New message";
  const context = document.createElement("p"); context.dataset.muted = "";
  const form = document.createElement("form");
  const conversationLabel = document.createElement("label"); conversationLabel.textContent = "Conversation";
  const select = document.createElement("select"); conversationLabel.appendChild(select);
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh conversations";
  const messageLabel = document.createElement("label"); messageLabel.textContent = "Message";
  const input = document.createElement("textarea"); input.rows = 4; input.maxLength = MAX_CODEX_MESSAGE_LENGTH;
  input.placeholder = "Tell Codex what to do next…"; messageLabel.appendChild(input);
  const hint = document.createElement("p"); hint.dataset.muted = "";
  hint.textContent = "Ctrl+Enter to send. Choose an existing conversation or start a new one in this project.";
  const send = document.createElement("button"); send.type = "submit"; send.textContent = "Send message";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "Close";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const error = document.createElement("p"); error.setAttribute("role", "alert");
  const attachmentRoot = document.createElement("section");
  const actions = document.createElement("div"); actions.dataset.composerActions = "";
  close.dataset.composerClose = ""; actions.append(close, send);
  form.append(conversationLabel, refresh, messageLabel, attachmentRoot, hint, actions, status, error);
  root.append(heading, context, form);
  const attachmentUI = mountCodexAttachmentsUI(attachmentRoot, form, bridge, () => active?.attachments, refreshUI);
  actions.insertBefore(attachmentUI.button, send);
  const unsubscribeRecovered = bridge.onRecoveredCodexInstanceMessage?.(delivery => {
    const draft = drafts.get(JSON.stringify([delivery.target.codexPid, delivery.target.codexStartedAt]));
    if (!draft || disposed) return;
    draft.sendRevision++; draft.sending = false;
    if (delivery.message !== undefined && sameMessageDraft(delivery.message, attachmentMessage(draft.text, draft.attachments)) && draft.conversationId === delivery.conversationId) {
      acknowledge(draft, delivery.receipt);
    } else {
      draft.error = ""; draft.status = "Previous message delivery confirmed. Your current draft is preserved.";
      if (active === draft) refreshUI();
    }
  });

  function renderChoices() {
    if (!active || disposed) return;
    select.replaceChildren();
    if (active.selectionMissing) {
      const missing = document.createElement("option"); missing.value = "__missing__";
      missing.textContent = "Choose a conversation"; missing.disabled = true; select.appendChild(missing);
    }
    {
      const placeholder = document.createElement("option"); placeholder.value = "";
      placeholder.textContent = active.loading ? "Loading conversations…" : "New conversation";
      select.appendChild(placeholder);
    }
    active.conversations.forEach(conversation => {
      const option = document.createElement("option"); option.value = conversation.id;
      option.textContent = `${conversation.title} · ${conversation.id.slice(0, 8)} · ${new Date(conversation.lastActiveAt).toLocaleString()}`;
      select.appendChild(option);
    });
    select.value = active.selectionMissing ? "__missing__" : active.conversationId;
  }
  function refreshUI() {
    if (!active || disposed) return;
    const draft = active, busy = draft.loading || draft.sending;
    context.textContent = `${draft.instance.title || "VS Code"} · ${draft.instance.workspace || "Folder unavailable"} · Codex PID ${draft.instance.codexPid}`;
    select.disabled = busy || !draft.available;
    input.disabled = draft.sending || !draft.available;
    refresh.disabled = busy || !draft.available;
    send.disabled = busy || !draft.available || draft.selectionMissing || (!draft.text.trim() && !draft.attachments.files.length);
    attachmentUI.refresh(draft.sending || !draft.available);
    send.textContent = draft.sending ? "Sending…" : "Send message";
    status.textContent = draft.status;
    error.textContent = draft.available ? draft.error : "This Codex instance has closed or restarted. Your draft is preserved.";
  }
  async function load(draft: Draft) {
    if (disposed || draft.loading || draft.sending || !bridge.getCodexInstanceConversations) return;
    draft.loading = true; draft.error = ""; draft.status = "Loading conversations…";
    if (active === draft) { renderChoices(); refreshUI(); }
    try {
      const conversations = await bridge.getCodexInstanceConversations(target(draft.instance));
      if (disposed) return;
      draft.conversations = conversations;
      if (!conversations.some(row => row.id === draft.conversationId)) {
        if (draft.conversationId) {
          draft.selectionMissing = true;
          draft.error = "The selected conversation is unavailable. Choose New conversation or another conversation before sending.";
        }
        draft.conversationId = "";
      }
      draft.loaded = true;
      draft.status = conversations.length ? "" : "No saved conversations in this project. Send a message to start one.";
    } catch (reason) { draft.error = errorText(reason); draft.status = ""; }
    finally {
      draft.loading = false;
      if (!disposed && active === draft) { renderChoices(); refreshUI(); }
    }
  }
  async function submit() {
    const draft = active;
    if (!draft || disposed || send.matches(":disabled") || !bridge.sendCodexInstanceMessage) return;
    const revision = ++draft.sendRevision;
    draft.sending = true; draft.error = ""; draft.status = "Sending to Codex…"; refreshUI();
    try {
      await attachmentUI.upload(draft.attachments);
      const receipt = await bridge.sendCodexInstanceMessage(target(draft.instance), draft.conversationId, attachmentMessage(draft.text, draft.attachments));
      if (disposed || draft.sendRevision !== revision) return;
      acknowledge(draft, receipt);
    } catch (reason) { if (draft.sendRevision === revision) { draft.error = errorText(reason); draft.status = ""; } }
    finally {
      if (draft.sendRevision === revision) {
        draft.sending = false; if (!disposed && active === draft) { refreshUI(); if (!root.hidden) input.focus(); }
      }
    }
  }
  function acknowledge(draft: Draft, receipt: CodexMessageReceipt) {
    const creating = !draft.conversationId;
    if (creating) {
      draft.conversations.unshift({ id: receipt.sessionId, title: draft.text.slice(0, 100) || draft.attachments.files[0]?.file.name || "Attachments", lastActiveAt: Date.now() });
      draft.conversationId = receipt.sessionId;
      if (active === draft) renderChoices();
    }
    draft.text = ""; draft.error = ""; draft.attachments = newAttachmentDraft();
    draft.status = creating ? "New conversation started. The response will appear in the Attention Inbox."
      : receipt.delivery === "steered" ? "Sent to the active Codex turn." : "Sent to Codex as a follow-up.";
    if (active === draft) { input.value = ""; refreshUI(); }
  }
  input.addEventListener("input", () => { if (active) { active.text = input.value; refreshUI(); } });
  select.addEventListener("change", () => { if (active) { active.conversationId = select.value; active.selectionMissing = false; active.status = ""; active.error = ""; refreshUI(); } });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  refresh.addEventListener("click", () => { if (active) void load(active); });
  close.addEventListener("click", () => { root.hidden = true; });
  return {
    open(instance: CodexInstance) {
      if (disposed) return;
      const id = identity(instance);
      let draft = drafts.get(id);
      if (!draft) { draft = { instance, conversations: [], conversationId: "", text: "", attachments: newAttachmentDraft(), loading: false, sending: false, sendRevision: 0,
        available: true, loaded: false, selectionMissing: false, status: "", error: "" }; drafts.set(id, draft); }
      draft.instance = instance; draft.available = true; active = draft;
      root.hidden = false; input.value = draft.text; renderChoices(); refreshUI();
      root.scrollIntoView({ block: "nearest" }); input.focus();
      if (!draft.loaded) void load(draft);
    },
    update(snapshot: CodexInstancesSnapshot) {
      for (const [id, draft] of drafts) {
        const instance = snapshot.instances.find(row => identity(row) === id);
        draft.available = !!instance; if (instance) draft.instance = instance;
      }
      refreshUI();
    },
    dispose() { disposed = true; unsubscribeRecovered?.(); attachmentUI.dispose(); drafts.clear(); root.replaceChildren(); },
  };
}
