import { CodexAttachmentsBridge } from "./codex-attachments";

export type CodexActivityState = "working" | "waiting" | "idle" | "unknown";
/** Bounded diagnostics only; never expose IPC payloads or conversation contents. */
export type CodexActivityReason = "no-conversations" | "history-unavailable" | "incomplete-mapping" | "coverage-limit"
  | "process-unavailable" | "connection-unavailable" | "owner-unavailable" | "snapshot-timeout"
  | "unsupported-protocol" | "unsupported-state" | "state-unavailable" | "resuming" | "check-failed";

export interface CodexInstance {
  codexPid: number;
  codexStartedAt: string;
  vscodePid: number;
  vscodeStartedAt: string;
  vscodeMainPid: number;
  windowPid?: number;
  windowId?: number;
  title?: string;
  workspace?: string;
  workspaceKind?: "folder" | "workspace";
  lastFileUpdatedAt?: number;
  activity?: CodexActivityState;
  activityCheckedAt?: number;
  activityReason?: CodexActivityReason;
  activityLastKnownAt?: number;
}

export interface CodexInstancesSnapshot {
  instances: CodexInstance[];
  supported: boolean;
  scanning: boolean;
  scannedAt?: number;
  error?: string;
  warning?: string;
}

export interface CodexInstancesBridge extends CodexAttachmentsBridge {
  getCodexInstances(): Promise<CodexInstancesSnapshot>;
  refreshCodexInstances(): Promise<CodexInstancesSnapshot>;
  onCodexInstancesChanged(callback: (snapshot: CodexInstancesSnapshot) => void): () => void;
  getCodexInstanceConversations?(target: CodexInstanceTarget): Promise<CodexInstanceConversation[]>;
  sendCodexInstanceMessage?(target: CodexInstanceTarget, conversationId: string, message: import("./codex-attachments").CodexMessageDraft): Promise<import("./codex-message").CodexMessageReceipt>;
  onRecoveredCodexInstanceMessage?(callback: (delivery: RecoveredCodexInstanceMessage) => void): () => void;
}

export interface CodexInstanceTarget { codexPid: number; codexStartedAt: string; }
export interface CodexInstanceConversation { id: string; title: string; lastActiveAt: number; }
export interface RecoveredCodexInstanceMessage {
  target: CodexInstanceTarget; receipt: import("./codex-message").CodexMessageReceipt;
  conversationId?: string; message?: import("./codex-attachments").CodexMessageDraft;
}

export interface ProcessDescriptor {
  pid: number;
  parentPid: number;
  name: string;
  startedAt: string;
  executablePath?: string;
  commandLine?: string;
}
