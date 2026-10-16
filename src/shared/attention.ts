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
export type AttentionState = "pending" | "snoozed" | "done";

export interface AttentionInput {
  title: string;
  description?: string;
  project?: string;
  destination?: Destination;
  sound?: string;
}

export interface AttentionItem extends AttentionInput {
  source: string;
  id: string;
  state: AttentionState;
  snoozedUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AttentionSnapshot {
  items: AttentionItem[];
  error?: string;
}

export interface AttentionBridge {
  getAttention(): Promise<AttentionSnapshot>;
  setAttentionState(source: string, id: string, state: AttentionState, minutes?: number): Promise<void>;
  goToAttention(source: string, id: string): Promise<void>;
  setAttentionDestination(source: string, id: string, destination: Destination): Promise<void>;
  listWindows(): Promise<WindowDestination[]>;
  onAttentionChanged(callback: (snapshot: AttentionSnapshot) => void): () => void;
}
