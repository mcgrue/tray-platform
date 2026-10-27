import { CodexActivityReason, CodexActivityState, CodexInstance } from "../shared/codex-instances";
import { CodexIpcBroadcast, CodexIpcClient } from "./codex-ipc";
import { CodexFileUpdates, CodexTurnOwner } from "./workspace-file-updates";

/** Native runtime state, not elapsed time since a file edit or a final message. */
export function codexThreadActivity(conversation: any): CodexActivityState {
  return threadObservation(conversation).state;
}

type Observation = { state: CodexActivityState; reason?: CodexActivityReason };
const unknown = (reason: CodexActivityReason): Observation => ({ state: "unknown", reason });

function threadObservation(conversation: any): Observation {
  const status = conversation?.threadRuntimeStatus;
  if (status?.type === "active") {
    if (!Array.isArray(status.activeFlags)) return unknown("unsupported-state");
    return status.activeFlags.some((flag: unknown) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
      ? { state: "waiting" } : status.activeFlags.length === 0 ? { state: "working" } : unknown("unsupported-state");
  }
  if (status?.type === "idle") {
    if (conversation.unconfirmedTurnSubmissions != null && !Array.isArray(conversation.unconfirmedTurnSubmissions)) return unknown("unsupported-state");
    // Submission can precede the server's active notification.
    if (Array.isArray(conversation.unconfirmedTurnSubmissions) &&
      conversation.unconfirmedTurnSubmissions.some((turn: any) => turn?.terminal !== true)) return { state: "working" };
    return conversation.resumeState === "resuming" ? unknown("resuming") : { state: "idle" };
  }
  return unknown(!status || ["notLoaded", "systemError"].includes(status.type) ? "state-unavailable" : "unsupported-state");
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

/** Short-lived, read-only subscriptions. Only status, reason codes and timestamps leave this reader. */
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
    instances.forEach(instance => {
      instance.activity = "unknown"; instance.activityCheckedAt = now; instance.activityReason = "process-unavailable";
    });
    const valid = instances.filter(instance => Number.isSafeInteger(instance.codexPid) && instance.codexPid > 0 &&
      Number.isFinite(Date.parse(instance.codexStartedAt)));
    if (this.closed || !valid.length) return;
    valid.forEach(instance => { instance.activityReason = "no-conversations"; });
    try {
      const since = Math.floor(Math.min(...valid.map(instance => Date.parse(instance.codexStartedAt))) / 1000);
      let owners: CodexTurnOwner[];
      try { owners = await (this.options.readOwners ? this.options.readOwners(since) : this.history.readTurnOwners(since, true)); }
      catch { valid.forEach(instance => { instance.activityReason = "history-unavailable"; }); return; }
      if (this.closed) return;
      const threads = currentCodexThreads(valid, owners, (this.options.now || Date.now)());
      for (const instance of valid) {
        if (owners.some(owner => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`) &&
          owner.firstObservedAt >= Date.parse(instance.codexStartedAt))) instance.activityReason = "incomplete-mapping";
      }
      // Bound work. Incomplete coverage must not produce an idle indicator.
      if (!threads.size) return;
      if (threads.size > 64) { valid.forEach(instance => { instance.activityReason = "coverage-limit"; }); return; }
      let candidates = valid.filter(instance => [...threads.values()].some(owner => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`)));
      if (this.options.verifyProcesses && !await this.options.verifyProcesses(candidates).catch(() => false)) {
        // An exited process must not blank the other instances until the next inventory scan.
        const running = await Promise.all(candidates.map(instance => this.options.verifyProcesses!([instance]).catch(() => false)));
        candidates.forEach((instance, index) => { if (!running[index]) instance.activityReason = "process-unavailable"; });
        candidates = candidates.filter((_, index) => running[index]);
        for (const [id, owner] of threads) if (!candidates.some(instance => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`))) threads.delete(id);
      }
      if (this.closed || !threads.size) return;
      const checkedAt = (this.options.now || Date.now)();
      const states = await this.readStates(threads);
      if (this.closed) return;
      for (const instance of candidates) {
        const relevant = [...threads].filter(([, owner]) => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`));
        const values = relevant.map(([id]) => states.get(id) || unknown("state-unavailable"));
        const unresolved = owners.some(owner => owner.processIdentity.startsWith(`pid:${instance.codexPid}:`) &&
          owner.firstObservedAt >= Date.parse(instance.codexStartedAt) && !threads.has(owner.threadId));
        if (unresolved) values.push(unknown("incomplete-mapping"));
        instance.activity = aggregateCodexActivity(values.map(value => value.state));
        instance.activityCheckedAt = checkedAt;
        if (instance.activity === "unknown") instance.activityReason = values.find(value => value.reason)?.reason || "state-unavailable";
        else { delete instance.activityReason; instance.activityLastKnownAt = checkedAt; }
      }
    } catch { valid.forEach(instance => { instance.activityReason = "check-failed"; }); }
  }

  close(): void {
    this.closed = true;
    this.history.close();
    this.cancelSnapshots.forEach(cancel => cancel());
    this.clients.forEach(client => client.close());
    this.clients.clear();
  }

  private async readStates(threads: Map<string, CodexTurnOwner>): Promise<Map<string, Observation>> {
    const states = new Map<string, Observation>();
    const pending = new Map<string, { owner: string; reason: CodexActivityReason; finish(state: Observation): void }>();
    const create = this.options.createClient || (listener => new CodexIpcClient(undefined, 2500, listener));
    let client: Client | undefined;
    try {
      client = create(message => {
        if (message.method !== "thread-stream-state-changed" || message.params?.hostId !== "local") return;
        const { conversationId, change } = message.params;
        const request = pending.get(conversationId);
        if (!request || request.owner !== message.sourceClientId) return;
        // Keep waiting: a supported snapshot may follow an unrelated-version broadcast.
        if (message.version !== 11) { request.reason = "unsupported-protocol"; return; }
        if (change?.type !== "snapshot") return;
        const state = change.conversationState;
        if (state?.id !== conversationId || (state.hostId !== undefined && state.hostId !== "local")) return;
        request.finish(threadObservation(state));
      });
      this.clients.add(client);
      await client.connect();
      const queue = [...threads.keys()];
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length && !this.closed) {
          const id = queue.shift()!;
          try {
            const response = await client!.request("thread-owner-discovery", { hostId: "local", conversationId: id }, 1);
            if (this.closed) break;
            if (response.resultType !== "success" || response.method !== "thread-owner-discovery" || !response.handledByClientId) {
              states.set(id, unknown("owner-unavailable")); continue;
            }
            const owner = response.handledByClientId;
            const state = await new Promise<Observation>(resolve => {
              const cancel = () => finish(unknown(pending.get(id)?.reason || "snapshot-timeout"));
              const finish = (value: Observation) => {
                clearTimeout(timer); pending.delete(id); this.cancelSnapshots.delete(cancel); resolve(value);
              };
              const timer = setTimeout(cancel, this.options.snapshotTimeoutMs ?? 1500);
              this.cancelSnapshots.add(cancel);
              pending.set(id, { owner, reason: "snapshot-timeout", finish });
              try { client!.followThread(id, owner, true); } catch { finish(unknown("connection-unavailable")); }
            });
            states.set(id, state);
            try { client!.followThread(id, owner, false); } catch { /* Disconnection also removes the subscription. */ }
          } catch { states.set(id, unknown("connection-unavailable")); }
        }
      }));
    } catch {
      for (const id of threads.keys()) states.set(id, unknown("connection-unavailable"));
    } finally {
      if (client) { client.close(); this.clients.delete(client); }
    }
    return states;
  }
}
