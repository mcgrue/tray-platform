import { randomUUID } from "crypto";
import { CODEX_APPROVAL_SOURCE, CodexApproval, CodexApprovalDecision, CodexApprovalReceipt, pendingApproval } from "../shared/codex-approval";
import { CodexInstance } from "../shared/codex-instances";
import { AttentionError, AttentionService } from "./attention-service";
import { CodexServerRequestContext } from "./codex-app-server";

interface Pending {
  id: string; value: CodexApproval; context: CodexServerRequestContext; ready: Promise<unknown>;
  resolve(value: unknown): void; reject(error: Error): void; abort(): void;
  decline: "decline" | "cancel"; dispatched: boolean; delivery?: Promise<CodexApprovalReceipt>;
}
const copy = (value: CodexApproval): CodexApproval => ({ ...value });

/** Only this process's live callbacks confer approval authority; stored cards never do. */
export class CodexApprovalService {
  private pending = new Map<string, Pending>();
  private closed = false;
  constructor(private attention: AttentionService) {}

  async initialize() {
    for (const item of this.attention.list().items) if (item.source === CODEX_APPROVAL_SOURCE && pendingApproval(item.approval)) {
      await this.attention.updateApproval(item.id, { ...item.approval!, status: item.approval!.status === "sending" ? "unknown" : "expired",
        canAllow: false, canDecline: false, notice: "Tray restarted. This request is no longer actionable; check the conversation." });
    }
  }

  async request(instance: CodexInstance, method: string, params: any, context: CodexServerRequestContext, proposedItem?: any): Promise<unknown> {
    if (this.closed || !context || context.signal.aborted) throw new Error("Codex approval request expired.");
    if (this.pending.size >= 128) throw new Error("Too many pending approvals.");
    const file = method === "item/fileChange/requestApproval";
    if (!file && method !== "item/commandExecution/requestApproval") throw new Error("Unsupported approval request.");
    for (const key of ["threadId", "turnId", "itemId"]) if (typeof params?.[key] !== "string" || !params[key] || params[key].length > 200) throw new Error("Invalid approval identity.");
    const network = !file && !!params.networkApprovalContext;
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "decline"];
    let notice = "", canAllow = decisions.includes("accept");
    const parts: string[] = [];
    const show = (label: string, value: unknown) => { if (value !== undefined && value !== null) parts.push(`${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`); };
    show("Reason", params.reason); show("Working directory", params.cwd || proposedItem?.cwd || instance.workspace);
    show("Environment", params.environmentId);
    if (file) {
      show("Requested write root", params.grantRoot);
      if (proposedItem?.type !== "fileChange" || !Array.isArray(proposedItem.changes) || !proposedItem.changes.length ||
        !proposedItem.changes.every((change: any) => typeof change.path === "string" && change.path.trim() && typeof change.diff === "string" &&
          ["add", "delete", "update"].includes(change.kind?.type) && (change.kind.move_path == null || typeof change.kind.move_path === "string"))) {
        canAllow = false; notice = "The complete proposed file changes are unavailable. Allow once is disabled.";
      } else for (const change of proposedItem.changes) {
        show(`File: ${change.path}\nChange: ${change.kind.type}${change.kind.move_path ? `\nMove to: ${change.kind.move_path}` : ""}`, change.diff);
      }
    } else {
      const command = params.command ?? proposedItem?.command;
      show("Command", command); show("Network access", params.networkApprovalContext);
      show("Additional permissions", params.additionalPermissions);
      if ((params.kind && params.kind !== "command") || (!network && (typeof command !== "string" || !command.trim())) ||
        (network && (typeof params.networkApprovalContext.host !== "string" || !params.networkApprovalContext.host.trim()))) {
        canAllow = false; notice = "This request needs an unsupported or unavailable preview. Allow once is disabled.";
      }
    }
    let details = parts.join("\n\n") || "No request details were provided.";
    if (details.length > 190000) { details = details.slice(0, 190000) + "\n[Preview truncated]"; canAllow = false; notice = "The request is too large to review here. Allow once is disabled."; }
    if (!decisions.includes("accept")) notice ||= "Codex did not offer a one-time approval for this request.";
    const value: CodexApproval = { kind: file ? "file" : network ? "network" : "command", threadId: params.threadId, turnId: params.turnId,
      itemId: params.itemId, status: "pending", details, canAllow, canDecline: decisions.includes("decline") || decisions.includes("cancel"), ...(notice ? { notice } : {}) };
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const answer = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    void answer.catch(() => {});
    const id = randomUUID();
    const entry: Pending = { id, value, context, resolve, reject, ready: Promise.resolve(), dispatched: false,
      decline: decisions.includes("decline") ? "decline" : "cancel", abort: () => this.expire(id) };
    this.pending.set(id, entry);
    entry.ready = this.attention.upsert(CODEX_APPROVAL_SOURCE, id, {
      title: `Approval required: ${network ? "network access" : file ? "file changes" : "command"} · ${instance.title || "Codex"}`.slice(0, 500),
      project: instance.workspace, approval: value, sound: "icq",
      origin: { kind: "vscode-codex", codexPid: instance.codexPid, codexStartedAt: instance.codexStartedAt,
        vscodePid: instance.vscodePid, vscodeStartedAt: instance.vscodeStartedAt, title: instance.title },
    }, { createOnly: true });
    context.signal.addEventListener("abort", entry.abort, { once: true });
    if (context.signal.aborted) entry.abort();
    try { await entry.ready; } catch (error) { this.forget(entry); reject(error as Error); throw error; }
    return answer;
  }

  get(source: string, id: string): CodexApproval {
    if (source !== CODEX_APPROVAL_SOURCE) throw new AttentionError("Not an approval request", 404);
    const live = this.pending.get(id);
    if (live) return copy(live.value);
    const value = this.attention.get(source, id)?.approval;
    if (!value) throw new AttentionError("Approval no longer exists", 404);
    return pendingApproval(value) ? { ...value, status: "expired", canAllow: false, canDecline: false, notice: "The original Codex request is no longer available." } : copy(value);
  }

  decide(source: string, id: string, decision: unknown): Promise<CodexApprovalReceipt> {
    if (decision !== "accept" && decision !== "decline") return Promise.reject(new AttentionError("Choose Allow once or Decline"));
    const current = this.get(source, id), entry = this.pending.get(id);
    if (entry?.delivery) return entry.delivery;
    if (!entry || current.status !== "pending") return Promise.resolve({ approval: current });
    if (entry.context.signal.aborted || this.closed) { this.expire(id); return Promise.resolve({ approval: this.get(source, id) }); }
    if ((decision === "accept" && !current.canAllow) || (decision === "decline" && !current.canDecline)) return Promise.reject(new AttentionError("This decision is unavailable for the request", 409));
    entry.value = { ...entry.value, status: "sending" };
    entry.delivery = this.deliver(entry, decision);
    return entry.delivery;
  }

  private async deliver(entry: Pending, decision: CodexApprovalDecision): Promise<CodexApprovalReceipt> {
    try {
      await entry.ready;
      await this.attention.updateApproval(entry.id, entry.value);
      if (entry.context.signal.aborted || entry.value.status !== "sending" || this.closed) return { approval: this.get(CODEX_APPROVAL_SOURCE, entry.id) };
      entry.dispatched = true;
      entry.resolve({ decision: decision === "accept" ? "accept" : entry.decline });
      await entry.context.responded;
      entry.value = { ...entry.value, status: decision === "accept" ? "allowed" : "declined", canAllow: false, canDecline: false,
        notice: decision === "accept" ? "Allow-once decision sent to Codex." : "Decline decision sent to Codex." };
      try { await this.attention.updateApproval(entry.id, entry.value); this.forget(entry); }
      catch { return { approval: copy(entry.value), warning: "Decision sent, but inbox storage could not be updated. Do not repeat the decision." }; }
      return { approval: copy(entry.value) };
    } catch (error) {
      if (pendingApproval(entry.value)) {
        entry.value = { ...entry.value, status: entry.dispatched ? "unknown" : "expired", canAllow: false, canDecline: false,
          notice: entry.dispatched ? "Decision delivery could not be confirmed. Check the conversation." : "The request could not be resolved; no approval was sent." };
        entry.reject(error as Error);
      }
      await this.persistEnded(entry);
      return { approval: copy(entry.value) };
    }
  }

  private expire(id: string) {
    const entry = this.pending.get(id);
    if (!entry || !pendingApproval(entry.value)) return;
    entry.value = { ...entry.value, status: entry.dispatched ? "unknown" : "expired", canAllow: false, canDecline: false,
      notice: entry.dispatched ? "Codex disconnected or cleared the request during delivery. Check the conversation." : "The Codex request ended. No approval was sent." };
    entry.reject(new Error("Codex approval request expired."));
    void this.persistEnded(entry);
  }
  private async persistEnded(entry: Pending) {
    try { await entry.ready; await this.attention.updateApproval(entry.id, entry.value); this.forget(entry); }
    catch { /* Keep terminal state in memory when the persisted inbox is unavailable. */ }
  }
  private forget(entry: Pending) { entry.context.signal.removeEventListener("abort", entry.abort); this.pending.delete(entry.id); }
  close() { this.closed = true; for (const id of this.pending.keys()) this.expire(id); }
}
