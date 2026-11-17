import { createHash, randomUUID } from "crypto";
import { AttentionItem } from "../shared/attention";
import { attentionCodexSession, CodexMessageReceipt, legacyCodexIdentity } from "../shared/codex-message";
import { CodexIpcClient, CodexIpcResponse } from "./codex-ipc";
import { CodexMessage, codexMessageParts, validateCodexMessage } from "./codex-attachments";
import { CodexTurnNotStartedError, CodexTurnOptions, CodexTurnSettings, hasTurnOptions, resolveTurnOptions, validateTurnOptions } from "../shared/codex-turn-controls";

type Client = Pick<CodexIpcClient, "connect" | "request" | "close">;

function result(response: CodexIpcResponse, method: string, owner?: string): any {
  if (response.resultType === "error") {
    if (response.error === "no-client-found" || response.error === "client-disconnected") {
      throw new Error("The Codex conversation is unavailable. Open it in Codex and try again.");
    }
    throw new Error(response.error || "Codex rejected the message.");
  }
  if (response.method !== method || (owner && response.handledByClientId !== owner)) {
    throw new Error("Unexpected Codex acknowledgement. Check the conversation before sending again.");
  }
  return response.result;
}

export class CodexMessageService {
  private readonly sending = new Set<string>();
  private readonly clients = new Set<Client>();
  private closed = false;
  constructor(private readonly createClient: () => Client = () => {
    if (process.platform !== "win32") throw new Error("Sending to Codex currently requires Windows.");
    return new CodexIpcClient();
  }, private readonly projectMessages?: { owns(id: string): boolean; sendExisting(id: string, message: CodexMessage,
    options?: CodexTurnOptions): Promise<CodexMessageReceipt> },
  private readonly resumeCompletion?: (item: AttentionItem, message: CodexMessage, options?: CodexTurnOptions) => Promise<CodexMessageReceipt>,
  private readonly catalogFor?: (item: AttentionItem) => Promise<CodexTurnSettings>) {}

  async turnSettings(item: AttentionItem, expectedOwner?: string, catalog?: CodexTurnSettings): Promise<CodexTurnSettings> {
    const sessionId = attentionCodexSession(item);
    if (!sessionId) throw new Error("This item has no Codex session.");
    const available = catalog || await this.catalogFor?.(item);
    if (!available) throw new Error("Codex model catalog is unavailable for this project.");
    if (this.projectMessages?.owns(sessionId)) return available;
    const client = this.createClient(); this.clients.add(client);
    try {
      await client.connect();
      const discovery = await client.request("thread-owner-discovery", { hostId: "local", conversationId: sessionId }, 1);
      if (discovery.resultType === "error" && discovery.error === "no-client-found") return available;
      result(discovery, "thread-owner-discovery");
      const owner = discovery.handledByClientId;
      if (!owner || (expectedOwner && expectedOwner !== owner)) throw new Error("This Codex conversation moved. Refresh settings.");
      return await this.ownerTurnSettings(client, owner, sessionId, available);
    } finally { client.close(); this.clients.delete(client); }
  }

  async send(item: AttentionItem, message: unknown, expectedOwner?: string, turnOptions?: CodexTurnOptions,
    catalog?: CodexTurnSettings): Promise<CodexMessageReceipt> {
    if (this.closed) throw new Error("Codex messaging is closed.");
    const sessionId = attentionCodexSession(item);
    if (!sessionId) throw new Error("This item has no Codex session. Open the conversation with Go.");
    if (!item.codexSessionId) {
      const identity = legacyCodexIdentity(item)!;
      const expected = "question-" + createHash("sha256").update(JSON.stringify([identity.session, identity.turn, identity.call])).digest("hex");
      if (item.id !== expected) throw new Error("Cannot verify this item's Codex session. Open the conversation with Go.");
    }
    validateCodexMessage(message);
    const options = validateTurnOptions(turnOptions);
    if (this.sending.has(sessionId)) throw new Error("A message is already being sent to this Codex conversation.");
    if (this.projectMessages?.owns(sessionId)) return hasTurnOptions(options)
      ? this.projectMessages.sendExisting(sessionId, message, options) : this.projectMessages.sendExisting(sessionId, message);
    this.sending.add(sessionId);
    let client: Client | undefined;
    try {
      client = this.createClient();
      this.clients.add(client);
      await client.connect();
      const discovery = await client.request("thread-owner-discovery", { hostId: "local", conversationId: sessionId }, 1);
      // A completed project thread may no longer have an IPC owner after Tray restarts.
      // Only a definitive discovery miss is safe to resume; delivery errors are ambiguous.
      if (discovery.resultType === "error" && ["no-client-found", "client-disconnected"].includes(discovery.error || "") &&
        /^completion-[a-f0-9]{64}$/.test(item.id) && this.resumeCompletion) {
        return await (hasTurnOptions(options) ? this.resumeCompletion(item, message, options) : this.resumeCompletion(item, message));
      }
      result(discovery, "thread-owner-discovery");
      const owner = discovery.handledByClientId;
      if (!owner) throw new Error("Codex did not identify the conversation owner.");
      if (expectedOwner && owner !== expectedOwner) throw new Error("This conversation moved to another Codex client. Refresh conversations before sending.");
      const id = randomUUID();
      const { text, input, attachments, fileAttachments, imageAttachments } = codexMessageParts(message);
      const restoreMessage = { id, text, createdAt: Date.now(), context: {
        prompt: text, addedFiles: [], fileAttachments, imageAttachments, ideContext: null,
      } };
      if (hasTurnOptions(options)) {
        const available = catalog || await this.catalogFor?.(item);
        if (!available) throw new Error("Codex model catalog is unavailable for this project.");
        const settings = await this.ownerTurnSettings(client, owner, sessionId, available);
        const overrides = resolveTurnOptions(options, settings);
        const method = "thread-follower-start-turn";
        const started = await client.request(method, { conversationId: sessionId, turnStart: {
          request: { threadId: sessionId, input, clientUserMessageId: id, ...overrides },
          context: { restoreMessage, ...(attachments.length ? { attachments } : {}),
            inheritThreadSettings: true, useUserMessageAdmission: false },
        } }, 2, owner);
        if (started.resultType === "error" && /active turn|turn.*in progress|already running/i.test(started.error || "")) {
          throw new CodexTurnNotStartedError("Codex is working. Wait for this turn to finish; your draft is preserved.");
        }
        const turnId = result(started, method, owner)?.result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
        return { sessionId, turnId, delivery: "started" };
      }
      const steerMethod = "thread-follower-steer-turn";
      const steered = await client.request(steerMethod, {
        conversationId: sessionId, input, restoreMessage, clientUserMessageId: id, attachments,
      }, 1, owner);
      // Only an explicit rejection before admission permits trying a new turn.
      // Timeouts, disconnects, and all other errors must never replay user input.
      const inactive = steered.resultType === "error" &&
        steered.error === `Cannot steer conversation ${sessionId} because its active turn already ended`;
      if (!inactive) {
        const turnId = result(steered, steerMethod, owner)?.result?.turnId;
        if (typeof turnId !== "string" || !turnId) throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
        return { sessionId, turnId, delivery: "steered" };
      }
      const startMethod = "thread-follower-start-turn";
      const started = await client.request(startMethod, { conversationId: sessionId, turnStart: {
        request: { threadId: sessionId, input, clientUserMessageId: id },
        // Owner discovery above is local. Admission uses a cloud-only transport;
        // local VS Code owners must use their ordinary turn/start path.
        context: { restoreMessage, ...(attachments.length ? { attachments } : {}), inheritThreadSettings: true, useUserMessageAdmission: false },
      } }, 2, owner);
      const turnId = result(started, startMethod, owner)?.result?.turn?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
      return { sessionId, turnId, delivery: "started" };
    } finally {
      if (client) { client.close(); this.clients.delete(client); }
      this.sending.delete(sessionId);
    }
  }

  private async ownerTurnSettings(client: Client, owner: string, sessionId: string, catalog: CodexTurnSettings): Promise<CodexTurnSettings> {
    const read = await client.request("thread-follower-read-model-settings", { conversationId: sessionId }, 1, owner);
    const current = result(read, "thread-follower-read-model-settings", owner)?.settings;
    if (!current || typeof current.model !== "string") throw new Error("Codex could not verify this conversation's settings.");
    if (catalog.provider && current.modelProvider && catalog.provider !== current.modelProvider) {
      throw new Error("This conversation uses a different model provider. Open it in Codex to change settings.");
    }
    return { ...catalog, current: { model: current.model,
      ...(typeof current.reasoningEffort === "string" || current.reasoningEffort === null ? { effort: current.reasoningEffort } : {}) } };
  }

  close(): void { this.closed = true; this.clients.forEach(client => client.close()); this.clients.clear(); }
}
