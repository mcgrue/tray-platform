export type CodexActivityState = "working" | "waiting" | "idle" | "unknown";

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
}

export interface CodexInstancesSnapshot {
  instances: CodexInstance[];
  supported: boolean;
  scanning: boolean;
  scannedAt?: number;
  error?: string;
  warning?: string;
}

export interface CodexInstancesBridge {
  getCodexInstances(): Promise<CodexInstancesSnapshot>;
  refreshCodexInstances(): Promise<CodexInstancesSnapshot>;
  onCodexInstancesChanged(callback: (snapshot: CodexInstancesSnapshot) => void): () => void;
  getCodexInstanceConversations?(target: CodexInstanceTarget): Promise<CodexInstanceConversation[]>;
  sendCodexInstanceMessage?(target: CodexInstanceTarget, conversationId: string, message: string): Promise<import("./codex-message").CodexMessageReceipt>;
}

export interface CodexInstanceTarget { codexPid: number; codexStartedAt: string; }
export interface CodexInstanceConversation { id: string; title: string; lastActiveAt: number; }

export interface ProcessDescriptor {
  pid: number;
  parentPid: number;
  name: string;
  startedAt: string;
  executablePath?: string;
  commandLine?: string;
}
