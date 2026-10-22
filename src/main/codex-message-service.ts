import { createHash, randomUUID } from "crypto";
import { AttentionItem } from "../shared/attention";
import { attentionCodexSession, CodexMessageReceipt, legacyCodexIdentity, MAX_CODEX_MESSAGE_LENGTH } from "../shared/codex-message";
import { CodexIpcClient, CodexIpcResponse } from "./codex-ipc";

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
  }) {}

  async send(item: AttentionItem, message: unknown): Promise<CodexMessageReceipt> {
    if (this.closed) throw new Error("Codex messaging is closed.");
    const sessionId = attentionCodexSession(item);
    if (!sessionId) throw new Error("This item has no Codex session. Open the conversation with Go.");
    if (!item.codexSessionId) {
      const identity = legacyCodexIdentity(item)!;
      const expected = "question-" + createHash("sha256").update(JSON.stringify([identity.session, identity.turn, identity.call])).digest("hex");
      if (item.id !== expected) throw new Error("Cannot verify this item's Codex session. Open the conversation with Go.");
    }
    if (typeof message !== "string" || !message.trim() || message.length > MAX_CODEX_MESSAGE_LENGTH) {
      throw new Error(`Enter a message of 1 to ${MAX_CODEX_MESSAGE_LENGTH} characters.`);
    }
    if (this.sending.has(sessionId)) throw new Error("A message is already being sent to this Codex conversation.");
    this.sending.add(sessionId);
    let client: Client | undefined;
    try {
      client = this.createClient();
      this.clients.add(client);
      await client.connect();
      const discovery = await client.request("thread-owner-discovery", { hostId: "local", conversationId: sessionId }, 1);
      result(discovery, "thread-owner-discovery");
      const owner = discovery.handledByClientId;
      if (!owner) throw new Error("Codex did not identify the conversation owner.");
      const id = randomUUID();
      const input = [{ type: "text", text: message, text_elements: [] }];
      const restoreMessage = { id, text: message, createdAt: Date.now(), context: {
        prompt: message, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null,
      } };
      const steerMethod = "thread-follower-steer-turn";
      const steered = await client.request(steerMethod, {
        conversationId: sessionId, input, restoreMessage, clientUserMessageId: id, attachments: [],
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
        context: { restoreMessage, inheritThreadSettings: true, useUserMessageAdmission: false },
      } }, 2, owner);
      const turnId = result(started, startMethod, owner)?.result?.turn?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Codex did not confirm the message. Check the conversation before sending again.");
      return { sessionId, turnId, delivery: "started" };
    } finally {
      if (client) { client.close(); this.clients.delete(client); }
      this.sending.delete(sessionId);
    }
  }

  close(): void { this.closed = true; this.clients.forEach(client => client.close()); this.clients.clear(); }
}
