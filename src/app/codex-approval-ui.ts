import { AttentionBridge, AttentionItem } from "../shared/attention";
import { CodexApproval, CodexApprovalDecision, pendingApproval } from "../shared/codex-approval";

export function mountCodexApprovalUI(root: HTMLElement, bridge: AttentionBridge, initial: AttentionItem) {
  let item = initial, value = item.approval, busy = false, disposed = false, revision = 0;
  root.dataset.codexApproval = "";
  const heading = document.createElement("h3"), context = document.createElement("p"), preview = document.createElement("pre");
  preview.dataset.approvalPreview = "";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const error = document.createElement("p"); error.setAttribute("role", "alert");
  const allow = document.createElement("button"), decline = document.createElement("button"), check = document.createElement("button");
  allow.type = decline.type = check.type = "button";
  allow.textContent = "Allow once"; allow.dataset.approvalDecision = "accept";
  decline.textContent = "Decline"; decline.dataset.approvalDecision = "decline";
  check.textContent = "Check approval status";
  root.append(heading, context, preview, status, decline, allow, check, error);
  function accept(next?: CodexApproval) {
    // A delayed snapshot cannot revive an already resolved request.
    if (!value || pendingApproval(value) || !pendingApproval(next)) value = next;
  }
  function refresh() {
    root.hidden = !value;
    if (!value) return;
    heading.textContent = value.kind === "file" ? "Review file changes" : value.kind === "network" ? "Review network access" : "Review command";
    context.textContent = `Conversation: ${value.threadId}`;
    preview.textContent = value.details;
    const labels = { pending: "Waiting for your decision.", sending: "Sending decision…", allowed: "Allowed once.", declined: "Declined.", expired: "Request expired.", unknown: "Decision delivery is unknown." };
    status.textContent = [labels[value.status], value.notice].filter(Boolean).join(" ");
    allow.disabled = busy || value.status !== "pending" || !value.canAllow || !bridge.answerAttentionApproval;
    decline.disabled = busy || value.status !== "pending" || !value.canDecline || !bridge.answerAttentionApproval;
    allow.hidden = decline.hidden = !pendingApproval(value);
    check.hidden = !bridge.getAttentionApproval; check.disabled = busy;
  }
  async function decide(decision: CodexApprovalDecision) {
    if (busy || (decision === "accept" ? allow : decline).matches(":disabled") || !bridge.answerAttentionApproval) return;
    busy = true; error.textContent = ""; refresh();
    try {
      const receipt = await bridge.answerAttentionApproval(item.source, item.id, decision);
      if (!disposed) { accept(receipt.approval); error.textContent = receipt.warning || ""; }
    } catch (reason) { if (!disposed) error.textContent = (reason as Error).message; }
    finally { busy = false; if (!disposed) refresh(); }
  }
  async function reload() {
    if (!value || !bridge.getAttentionApproval) return;
    const current = ++revision;
    try {
      const next = await bridge.getAttentionApproval(item.source, item.id);
      if (!disposed && current === revision) { accept(next); error.textContent = ""; refresh(); }
    } catch (reason) { if (!disposed && current === revision) error.textContent = (reason as Error).message; }
  }
  allow.onclick = () => { void decide("accept"); }; decline.onclick = () => { void decide("decline"); };
  check.onclick = () => { void reload(); };
  const unsubscribe = bridge.onRecoveredDelivery?.(delivery => {
    if (delivery.source === item.source && delivery.id === item.id && delivery.action === "approvals") void reload();
  });
  refresh();
  return { update(next: AttentionItem) { revision++; item = next; accept(item.approval); refresh(); }, dispose() { disposed = true; unsubscribe?.(); } };
}
