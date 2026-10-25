import { CodexAttachmentsBridge } from "./codex-attachments";

export interface WindowDestination {
  kind: "window";
  hwnd: string;
  pid: number;
  processStartedAt: string;
  title?: string;
}

export interface UrlDestination {
  kind: "url";
  url: string;
}

export type Destination = WindowDestination | UrlDestination;
export type AttentionState = "pending" | "done";

export interface CodexOrigin {
  kind: "vscode-codex";
  codexPid: number;
  codexStartedAt: string;
  vscodePid: number;
  vscodeStartedAt: string;
  title?: string;
}

export interface AttentionInput {
  title: string;
  codexSessionId?: string;
  description?: string;
  project?: string;
  destination?: Destination;
  origin?: CodexOrigin;
  sound?: string;
  approval?: import("./codex-approval").CodexApproval;
}

export function canNavigateAttention(item: AttentionInput | undefined): boolean {
  return Boolean(item?.destination || item?.origin);
}

export function codexOriginLabel(origin: CodexOrigin): string {
  return `${origin.title || "VS Code"} (VS Code PID ${origin.vscodePid}, Codex PID ${origin.codexPid})`;
}

export interface AttentionItem extends AttentionInput {
  source: string;
  id: string;
  state: AttentionState;
  createdAt: number;
  updatedAt: number;
}

export interface AttentionSnapshot {
  items: AttentionItem[];
  error?: string;
}

export interface NavigationProgress {
  phase: "scanning" | "activating" | "opened";
  destination?: string;
}

export interface AttentionNavigationProgress extends NavigationProgress {
  source: string;
  id: string;
}

export interface AttentionBridge extends CodexAttachmentsBridge {
  onRecoveredDelivery?(callback: (delivery: { source: string; id: string; action: "messages" | "answers" | "approvals" }) => void): () => void;
  getAttention(): Promise<AttentionSnapshot>;
  setAttentionState(source: string, id: string, state: AttentionState): Promise<void>;
  goToAttention(source: string, id: string): Promise<void>;
  sendAttentionMessage?(source: string, id: string, message: import("./codex-attachments").CodexMessageDraft): Promise<import("./codex-message").CodexMessageReceipt>;
  getAttentionQuestion?(source: string, id: string): Promise<import("./codex-question").CodexQuestion[]>;
  answerAttentionQuestion?(source: string, id: string, answers: import("./codex-question").CodexQuestionAnswer[]): Promise<import("./codex-question").CodexAnswerReceipt>;
  getAttentionApproval?(source: string, id: string): Promise<import("./codex-approval").CodexApproval>;
  answerAttentionApproval?(source: string, id: string, decision: import("./codex-approval").CodexApprovalDecision): Promise<import("./codex-approval").CodexApprovalReceipt>;
  setAttentionDestination(source: string, id: string, destination: Destination): Promise<void>;
  listWindows(): Promise<WindowDestination[]>;
  onAttentionChanged(callback: (snapshot: AttentionSnapshot) => void): () => void;
  onShowAttention?(callback: () => void): () => void;
  onAttentionNavigationProgress?(callback: (progress: AttentionNavigationProgress) => void): () => void;
}

export type ShortcutKey = "navigate" | "capture";
export interface ShortcutSetting {
  key: ShortcutKey;
  accelerator: string;
  registered: boolean;
  error?: string;
}
export interface ShortcutSnapshot {
  settings: ShortcutSetting[];
  error?: string;
}
export interface NavigationBridge extends AttentionBridge {
  getShortcuts(): Promise<ShortcutSnapshot>;
  setShortcut(key: ShortcutKey, accelerator: string): Promise<void>;
  navigatePending(): Promise<void>;
  goToPending(source: string, id: string): Promise<void>;
  onShortcutsChanged(callback: (snapshot: ShortcutSnapshot) => void): () => void;
  onShowNavigation(callback: (message: { error?: string }) => void): () => void;
}
