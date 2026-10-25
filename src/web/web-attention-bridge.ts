import { AttentionBridge, AttentionSnapshot, AttentionState, Destination } from "../shared/attention";
import { CodexMessageReceipt } from "../shared/codex-message";
import { CodexAnswerReceipt, CodexQuestion, CodexQuestionAnswer } from "../shared/codex-question";
import { CodexInstanceConversation, CodexInstancesBridge, CodexInstancesSnapshot, CodexInstanceTarget, RecoveredCodexInstanceMessage } from "../shared/codex-instances";
import { CodexApproval, CodexApprovalDecision, CodexApprovalReceipt } from "../shared/codex-approval";
import { CodexAttachment, CodexAttachmentUpload, CodexMessageDraft } from "../shared/codex-attachments";

interface Receipt { state: "unknown" | "succeeded"; result?: any; error?: string; }
export class WebAttentionBridge implements AttentionBridge, CodexInstancesBridge {
  private token = "";
  private events?: EventSource;
  private listeners = new Set<(snapshot: AttentionSnapshot) => void>();
  private instanceListeners = new Set<(snapshot: CodexInstancesSnapshot) => void>();
  private recoveredInstances = new Set<(delivery: RecoveredCodexInstanceMessage) => void>();
  private pendingValues = new Map<string, any>(); // Only in memory; never persist message text.
  private stopped = false;
  private pending = new Map<string, string>();
  private checking?: Promise<void>;
  private recovered = new Set<(delivery: { source: string; id: string; action: "messages" | "answers" | "approvals" }) => void>();
  constructor(private connection: (online: boolean) => void, private deliveryChanged: () => void) {
    try {
      const saved = JSON.parse(sessionStorage.getItem("tray-pending-deliveries") || "[]");
      if (Array.isArray(saved)) for (const entry of saved) if (Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string")) this.pending.set(entry[0], entry[1]);
    } catch { /* An unavailable store is handled before sending. */ }
  }
  private savePending() { sessionStorage.setItem("tray-pending-deliveries", JSON.stringify([...this.pending])); this.deliveryChanged(); }
  async request<T = any>(url: string, input?: unknown, timeoutMs = 45000): Promise<T> {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: input === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
        headers: input === undefined ? {} : { "Content-Type": "application/json", "X-Tray-CSRF": this.token },
        body: input === undefined ? undefined : JSON.stringify(input) });
      const value = await response.json();
      if (!response.ok) { if (response.status === 403) { this.token = ""; this.connection(false); } throw new Error(value.error || "Request failed"); }
      return value;
    } finally { clearTimeout(timeout); }
  }
  async connect() {
    if (this.stopped) return;
    try {
      this.token = (await this.request<{ csrf: string }>("/api/session")).csrf;
      await this.refresh();
      this.events?.close();
      this.events = new EventSource("/api/events");
      let authorized = false;
      this.events.onopen = () => {
        authorized = false; this.connection(false);
        void this.request<{ csrf: string }>("/api/session").then(session => {
          this.token = session.csrf; authorized = true; this.connection(true);
        }).catch(() => this.connection(false));
      };
      this.events.addEventListener("attention", event => {
        try { const snapshot = JSON.parse((event as MessageEvent).data); this.publish(snapshot); if (authorized) this.connection(true); }
        catch { this.connection(false); }
      });
      this.events.addEventListener("codex-instances", event => {
        try { const snapshot = JSON.parse((event as MessageEvent).data); this.instanceListeners.forEach(listener => listener(snapshot)); }
        catch { this.connection(false); }
      });
      this.events.onerror = () => this.connection(false);
    } catch { this.connection(false); }
  }
  async refresh() {
    if (!this.token) { await this.connect(); return; }
    const snapshot = await this.getAttention(); this.publish(snapshot);
  }
  private publish(snapshot: AttentionSnapshot) { this.listeners.forEach(listener => listener(snapshot)); }
  getAttention() { return this.request<AttentionSnapshot>("/api/attention"); }
  onAttentionChanged(callback: (snapshot: AttentionSnapshot) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  onRecoveredDelivery(callback: (delivery: { source: string; id: string; action: "messages" | "answers" | "approvals" }) => void) {
    this.recovered.add(callback); return () => { this.recovered.delete(callback); };
  }
  private route(source: string, id: string, action: string) { return `/api/attention/${encodeURIComponent(source)}/${encodeURIComponent(id)}/${action}`; }
  async setAttentionState(source: string, id: string, state: AttentionState) {
    await this.request(this.route(source, id, "state"), { state });
  }
  getAttentionQuestion(source: string, id: string) { return this.request<CodexQuestion[]>(this.route(source, id, "questions")); }
  private async deliver<T>(source: string, id: string, action: string, value: unknown): Promise<T> {
    const route = this.route(source, id, action);
    return this.deliverRoute<T>(route, value);
  }
  private async deliverRoute<T>(route: string, value: unknown): Promise<T> {
    const previous = this.pending.get(route);
    if (previous) {
      throw new Error("A previous send needs checking. Use Check delivery above before sending another instruction.");
    }
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    this.pending.set(route, requestId);
    try { this.savePending(); } catch { this.pending.delete(route); throw new Error("Browser storage is unavailable; sending is disabled to prevent duplicate delivery."); }
    this.pendingValues.set(route, value);
    let receipt: Receipt;
    try { receipt = await this.request<Receipt>(route, { requestId, value }); }
    catch { throw new Error("Delivery is unconfirmed. Use Check delivery above before sending again."); }
    if (receipt.state !== "succeeded") throw new Error(`${receipt.error || "Delivery was not confirmed"}. Check Codex before allowing another send.`);
    if (this.pending.get(route) === requestId) { this.pending.delete(route); this.pendingValues.delete(route); this.savePending(); }
    return receipt.result;
  }
  uploadCodexAttachment(upload: CodexAttachmentUpload) { return this.request<CodexAttachment>("/api/attachments", upload, 90000); }
  sendAttentionMessage(source: string, id: string, message: CodexMessageDraft) { return this.deliver<CodexMessageReceipt>(source, id, "messages", message); }
  answerAttentionQuestion(source: string, id: string, answers: CodexQuestionAnswer[]) { return this.deliver<CodexAnswerReceipt>(source, id, "answers", answers); }
  getAttentionApproval(source: string, id: string) { return this.request<CodexApproval>(this.route(source, id, "approvals")); }
  answerAttentionApproval(source: string, id: string, decision: CodexApprovalDecision) { return this.deliver<CodexApprovalReceipt>(source, id, "approvals", decision); }
  getCodexInstances() { return this.request<CodexInstancesSnapshot>("/api/codex-instances"); }
  async refreshCodexInstances() {
    const snapshot = await this.request<CodexInstancesSnapshot>("/api/codex-instances/refresh", {});
    this.instanceListeners.forEach(listener => listener(snapshot)); return snapshot;
  }
  onCodexInstancesChanged(callback: (snapshot: CodexInstancesSnapshot) => void) {
    this.instanceListeners.add(callback); return () => { this.instanceListeners.delete(callback); };
  }
  private instanceRoute(target: CodexInstanceTarget, action: string) {
    return `/api/codex-instances/${target.codexPid}/${encodeURIComponent(target.codexStartedAt)}/${action}`;
  }
  getCodexInstanceConversations(target: CodexInstanceTarget) {
    return this.request<CodexInstanceConversation[]>(this.instanceRoute(target, "conversations"));
  }
  sendCodexInstanceMessage(target: CodexInstanceTarget, conversationId: string, message: CodexMessageDraft) {
    return this.deliverRoute<CodexMessageReceipt>(this.instanceRoute(target, "messages"), { conversationId, message });
  }
  onRecoveredCodexInstanceMessage(callback: (delivery: RecoveredCodexInstanceMessage) => void) {
    this.recoveredInstances.add(callback); return () => { this.recoveredInstances.delete(callback); };
  }
  get pendingCount() { return this.pending.size; }
  async checkDeliveries() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      for (const [route, id] of this.pending) {
        const receipt = await this.request<Receipt>(`/api/requests/${id}`);
        if (receipt.state === "succeeded") {
          this.pending.delete(route);
          const match = /^\/api\/attention\/([^/]+)\/([^/]+)\/(messages|answers|approvals)$/.exec(route);
          if (match) this.recovered.forEach(callback => callback({ source: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]), action: match[3] as "messages" | "answers" | "approvals" }));
          const instance = /^\/api\/codex-instances\/([1-9]\d*)\/([^/]+)\/messages$/.exec(route);
          if (instance) this.recoveredInstances.forEach(callback => callback({ target: {
            codexPid: Number(instance[1]), codexStartedAt: decodeURIComponent(instance[2]),
          }, receipt: receipt.result, conversationId: this.pendingValues.get(route)?.conversationId, message: this.pendingValues.get(route)?.message }));
          this.pendingValues.delete(route);
        }
      }
      this.savePending(); await this.refresh();
    })();
    try { await this.checking; } finally { this.checking = undefined; }
  }
  allowAnotherSend() { this.pending.clear(); this.pendingValues.clear(); this.savePending(); }
  async goToAttention() { throw new Error("Desktop navigation is unavailable on the phone"); }
  async setAttentionDestination(_source: string, _id: string, _destination: Destination) { throw new Error("Edit destinations on the desktop"); }
  async listWindows() { return []; }
  close() { this.stopped = true; this.events?.close(); this.instanceListeners.clear(); this.recoveredInstances.clear(); this.pendingValues.clear(); }
}
