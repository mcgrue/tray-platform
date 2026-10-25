export const CODEX_APPROVAL_SOURCE = "codex-approval";
export type CodexApprovalDecision = "accept" | "decline";
export type CodexApprovalStatus = "pending" | "sending" | "allowed" | "declined" | "expired" | "unknown";
export interface CodexApproval {
  kind: "command" | "file" | "network";
  threadId: string;
  turnId: string;
  itemId: string;
  status: CodexApprovalStatus;
  details: string;
  canAllow: boolean;
  canDecline: boolean;
  notice?: string;
}
export interface CodexApprovalReceipt { approval: CodexApproval; warning?: string; }
export const pendingApproval = (approval?: CodexApproval) => approval?.status === "pending" || approval?.status === "sending";
