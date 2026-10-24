import { CodexActivityState, CodexInstance } from "../shared/codex-instances";
import { CodexIpcBroadcast, CodexIpcClient } from "./codex-ipc";
import { CodexFileUpdates, CodexTurnOwner } from "./workspace-file-updates";

/** Native runtime state, not elapsed time since a file edit or a final message. */
export function codexThreadActivity(conversation: any): CodexActivityState {
  const status = conversation?.threadRuntimeStatus;
  if (status?.type === "active") {
    if (!Array.isArray(status.activeFlags)) return "unknown";
    return status.activeFlags.some((flag: unknown) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
      ? "waiting" : status.activeFlags.length === 0 ? "working" : "unknown";
  }
  if (status?.type === "idle") {
    // Submission can precede the server's active notification.
    if (conversation.unconfirmedTurnSubmissions?.some((turn: any) => turn?.terminal !== true)) return "working";
    return conversation.resumeState === "resuming" ? "unknown" : "idle";
  }
  return "unknown";
}

export function aggregateCodexActivity(states: CodexActivityState[]): CodexActivityState {
  if (states.includes("working")) return "working";
  if (states.includes("waiting")) return "waiting";
  return states.length && states.every(state => state === "idle") ? "idle" : "unknown";
}

/** A resumed thread belongs to its latest observed executor, not every past executor. */
export function currentCodexThreads(instances: CodexInstance[], owners: CodexTurnOwner[], now: number): Map<string, CodexTurnOwner> {
  const byThread = new Map<string, CodexTurnOwner[]>();
  for (const owner of owners) {
    if (owner.firstObservedAt > owner.lastObservedAt || owner.lastObservedAt > now) continue;
    const entries = byThread.get(owner.threadId) || [];
    entries.push(owner); byThread.set(owner.threadId, entries);
  }
  const result = new Map<string, CodexTurnOwner>();
  for (const [id, entries] of byThread) {
    entries.sort((a, b) => b.lastObservedAt - a.lastObservedAt);
    const latest = entries[0];
    if (entries.some(entry => entry.lastObservedAt === latest.lastObservedAt && entry.processIdentity !== latest.processIdentity)) continue;
    const pid = Number(/^pid:(\d+):/.exec(latest.processIdentity)?.[1]);
    const instance = instances.find(item => item.codexPid === pid);
    if (!instance || latest.firstObservedAt < Date.parse(instance.codexStartedAt)) continue;
    result.set(id, latest);
  }
  return result;
}

type Client = Pick<CodexIpcClient, "connect" | "request" | "followThread" | "close">;
type CreateClient = (onBroadcast: (message: CodexIpcBroadcast) => void) => Client;

/** Short-lived, read-only subscriptions. Only the reduced status leaves this reader. */
export class CodexActivity {
  private readonly history = new CodexFileUpdates();
  private readonly clients = new Set<Client>();
  private readonly cancelSnapshots = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: {
    readOwners?: (since: number) => Promise<CodexTurnOwner[]>;
    createClient?: CreateClient;
    now?: () => number;
    snapshotTimeoutMs?: number;
    verifyProcesses?: (instances: CodexInstance[]) => Promise<boolean>;
  } = {}) {}

  async enrich(instances: CodexInstance[]): Promise<void> {
    const now = (this.options.now || Date.now)();
    instances.forEach(instance => { instance.activity = "unknown"; instance.activityCheckedAt = now; });
    const valid = instances.filter(instance => Number.isSafeInteger(instance.codexPid) && instance.codexPid > 0 &&
      Number.isFinite(Date.parse(instance.codexStartedAt)));
    if (this.closed || !valid.length) return;
    try {
      const since = Math.floor(Math.min(...valid.map(instance => Date.parse(instance.codexStartedAt))) / 1000);
      const owners = await (this.options.readOwners ? this.options.readOwners(since) : this.history.readTurnOwners(since, true));
      if (this.closed) return;
      const threads = currentCodexThreads(valid, owners, (this.options.now || Date.now)());
      // Bound work. Incomplete coverage must not produce an idle indicator.
      if (!threads.size || threads.size > 64) return;
      let candidates = valid.filter(instance => [...threads.values()].some(owner => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`)));
      if (this.options.verifyProcesses && !await this.options.verifyProcesses(candidates)) {
        // An exited process must not blank the other instances until the next inventory scan.
        const running = await Promise.all(candidates.map(instance => this.options.verifyProcesses!([instance]).catch(() => false)));
        candidates = candidates.filter((_, index) => running[index]);
        for (const [id, owner] of threads) if (!candidates.some(instance => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`))) threads.delete(id);
      }
      if (this.closed || !threads.size) return;
      const checkedAt = (this.options.now || Date.now)();
      const states = await this.readStates(threads);
      if (this.closed) return;
      for (const instance of candidates) {
        const relevant = [...threads].filter(([, owner]) => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`));
        const values = relevant.map(([id]) => states.get(id) || "unknown");
        const unresolved = owners.some(owner => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`) &&
          owner.firstObservedAt >= Date.parse(instance.codexStartedAt) && !threads.has(owner.threadId));
        if (unresolved) values.push("unknown");
        instance.activity = aggregateCodexActivity(values);
        instance.activityCheckedAt = checkedAt;
      }
    } catch { /* Missing/changed internals or a disconnected extension remain unknown. */ }
  }

  close(): void {
    this.closed = true;
    this.history.close();
    this.cancelSnapshots.forEach(cancel => cancel());
    this.clients.forEach(client => client.close());
    this.clients.clear();
  }

  private async readStates(threads: Map<string, CodexTurnOwner>): Promise<Map<string, CodexActivityState>> {
    const states = new Map<string, CodexActivityState>();
    const pending = new Map<string, { owner: string; finish(state: CodexActivityState): void }>();
    const create = this.options.createClient || (listener => new CodexIpcClient(undefined, 2500, listener));
    const client = create(message => {
      if (message.method !== "thread-stream-state-changed" || message.version !== 11 || message.params?.hostId !== "local") return;
      const { conversationId, change } = message.params;
      const request = pending.get(conversationId);
      if (!request || request.owner !== message.sourceClientId || change?.type !== "snapshot") return;
      const state = change.conversationState;
      if (state?.id !== conversationId || (state.hostId !== undefined && state.hostId !== "local")) return;
      request.finish(codexThreadActivity(state));
    });
    this.clients.add(client);
    try {
      await client.connect();
      const queue = [...threads.keys()];
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length && !this.closed) {
          const id = queue.shift()!;
          try {
            const response = await client.request("thread-owner-discovery", { hostId: "local", conversationId: id }, 1);
            if (this.closed || response.resultType !== "success" || response.method !== "thread-owner-discovery" || !response.handledByClientId) continue;
            const owner = response.handledByClientId;
            const state = await new Promise<CodexActivityState>(resolve => {
              const cancel = () => finish("unknown");
              const finish = (value: CodexActivityState) => {
                clearTimeout(timer); pending.delete(id); this.cancelSnapshots.delete(cancel); resolve(value);
              };
              const timer = setTimeout(cancel, this.options.snapshotTimeoutMs ?? 1500);
              this.cancelSnapshots.add(cancel);
              pending.set(id, { owner, finish });
              try { client.followThread(id, owner, true); } catch { cancel(); }
            });
            states.set(id, state);
            try { client.followThread(id, owner, false); } catch { /* Disconnection also removes the subscription. */ }
          } catch { states.set(id, "unknown"); }
        }
      }));
      return states;
    } finally {
      client.close(); this.clients.delete(client);
    }
  }
}
