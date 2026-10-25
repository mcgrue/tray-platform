import { CodexInstance, CodexInstanceConversation, CodexInstanceTarget, CodexInstancesSnapshot } from "../shared/codex-instances";
import { isCodexSessionId, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexIpcClient } from "./codex-ipc";
import { CodexMessageService } from "./codex-message-service";
import { CodexProjectSessions } from "./codex-project-sessions";

type Client = Pick<CodexIpcClient, "connect" | "request" | "close">;
const key = (target: CodexInstanceTarget, id: string) => JSON.stringify([target.codexPid, target.codexStartedAt, id]);

/** Resolve the selected live instance, then authorize conversation IDs against its project. */
export class CodexInstanceMessages {
  private readonly offered = new Set<string>();
  private readonly clients = new Set<Client>();
  private closed = false;
  constructor(private readonly options: {
    inventory: { list(): CodexInstancesSnapshot };
    verifyProcesses(identities: Array<{ pid: number; startedAt: string }>): Promise<boolean>;
    messages: Pick<CodexMessageService, "send">;
    projects: Pick<CodexProjectSessions, "conversations" | "send" | "owns">;
    createClient?: () => Client;
    now?: () => number;
  }) {}

  async conversations(target: CodexInstanceTarget): Promise<CodexInstanceConversation[]> {
    const instance = await this.resolveInstance(target);
    const conversations = await this.options.projects.conversations(instance);
    if (this.closed) throw new Error("Codex messaging is closed.");
    conversations.forEach(row => this.offered.add(key(target, row.id)));
    while (this.offered.size > 10000) this.offered.delete(this.offered.values().next().value!);
    return conversations;
  }

  async send(target: CodexInstanceTarget, conversationId: string, message: unknown) {
    if (conversationId !== "" && !isCodexSessionId(conversationId)) throw new Error("Select a Codex conversation.");
    if (typeof message !== "string" || !message.trim() || message.length > MAX_CODEX_MESSAGE_LENGTH) {
      throw new Error(`Enter a message of 1 to ${MAX_CODEX_MESSAGE_LENGTH} characters.`);
    }
    const instance = await this.resolveInstance(target);
    if (!conversationId) {
      const receipt = await this.options.projects.send(instance, "", message);
      this.offered.add(key(target, receipt.sessionId));
      return receipt;
    }
    if (!this.offered.has(key(target, conversationId))) throw new Error("Refresh conversations before sending to this project.");
    if (this.options.projects.owns(conversationId)) return this.options.projects.send(instance, conversationId, message);
    const current = await this.options.projects.conversations(instance);
    if (!current.some(row => row.id === conversationId)) throw new Error("This conversation is no longer in this project. Refresh conversations.");
    const client = this.options.createClient?.() || new CodexIpcClient(undefined, 2500);
    this.clients.add(client);
    try {
      await client.connect();
      const response = await client.request("thread-owner-discovery", { hostId: "local", conversationId }, 1);
      if (response.resultType === "error" && response.error === "no-client-found") {
        return this.options.projects.send(instance, conversationId, message);
      }
      if (response.resultType !== "success" || response.method !== "thread-owner-discovery" || typeof response.handledByClientId !== "string") {
        throw new Error("Could not verify the Codex conversation owner. Refresh conversations before sending.");
      }
      const now = (this.options.now || Date.now)();
      return this.options.messages.send({ source: "codex", id: "instance-message", codexSessionId: conversationId,
        title: instance.title || "Codex instance", project: instance.workspace, state: "pending", createdAt: now, updatedAt: now }, message, response.handledByClientId);
    } finally { client.close(); this.clients.delete(client); }
  }

  close() { this.closed = true; this.clients.forEach(client => client.close()); this.clients.clear(); this.offered.clear(); }

  private async resolveInstance(target: CodexInstanceTarget): Promise<CodexInstance> {
    if (this.closed) throw new Error("Codex messaging is closed.");
    if (!target || !Number.isSafeInteger(target.codexPid) || target.codexPid < 1 || typeof target.codexStartedAt !== "string" || !Number.isFinite(Date.parse(target.codexStartedAt))) {
      throw new Error("Invalid Codex instance.");
    }
    const instances = this.options.inventory.list().instances;
    const instance = instances.find(row => row.codexPid === target.codexPid && row.codexStartedAt === target.codexStartedAt);
    if (!instance || !await this.options.verifyProcesses([{ pid: instance.codexPid, startedAt: instance.codexStartedAt },
      { pid: instance.vscodePid, startedAt: instance.vscodeStartedAt }])) throw new Error("This Codex instance has closed or restarted. Refresh the instance list.");
    return instance;
  }

}
