import { CodexActivity } from "./codex-activity";
import { CodexIpcBroadcast } from "./codex-ipc";
import { CodexActivityReason, CodexInstance } from "../shared/codex-instances";
import { CodexTurnOwner } from "./workspace-file-updates";

const instance = (): CodexInstance => ({ codexPid: 42, codexStartedAt: new Date(1000).toISOString(),
  vscodePid: 2, vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 3 });
const owner = (threadId = "a", pid = 42): CodexTurnOwner => ({ threadId, turnId: "turn", processIdentity: `pid:${pid}:start`,
  firstObservedAt: 1100, lastObservedAt: 1200, rolloutPath: "C:\\sessions\\fixture.jsonl" });

function fixture() {
  const rows = [instance()];
  const setup = { now: 2000, owners: [owner()], historyFails: false, connected: true, discovered: true,
    running: true, snapshot: true, version: 11, foreign: false, sendSupportedAfter: false,
    conversation: { threadRuntimeStatus: { type: "idle" } } as any };
  const close = jest.fn(), follow = jest.fn();
  const activity = new CodexActivity({ now: () => setup.now, snapshotTimeoutMs: 5,
    readOwners: async () => { if (setup.historyFails) throw Error("private history path/content"); return setup.owners; },
    verifyProcesses: async () => setup.running,
    createClient: notify => ({
      connect: async () => { if (!setup.connected) throw Error("private connection details"); }, close,
      request: async method => ({ type: "response", requestId: "id", method, resultType: "success",
        handledByClientId: setup.discovered ? "owner" : undefined }),
      followThread: (id, source, following) => {
        follow(id, source, following);
        if (!following || !setup.snapshot) return;
        const message: CodexIpcBroadcast = { type: "broadcast", method: "thread-stream-state-changed",
          version: setup.version, sourceClientId: setup.foreign ? "someone-else" : source,
          params: { hostId: "local", conversationId: id,
            change: { type: "snapshot", conversationState: { id, ...setup.conversation } } } };
        notify(message);
        if (setup.sendSupportedAfter) notify({ ...message, version: 11 });
      },
    }),
  });
  return { rows, setup, activity, close, follow };
}

test.each<[string, (f: ReturnType<typeof fixture>) => void, CodexActivityReason]>([
  ["no conversations", f => { f.setup.owners = []; }, "no-conversations"],
  ["missing history", f => { f.setup.historyFails = true; }, "history-unavailable"],
  ["ambiguous mappings", f => { f.setup.owners.push(owner("a", 99)); }, "incomplete-mapping"],
  ["bounded coverage", f => { f.setup.owners = Array.from({ length: 65 }, (_, n) => owner(String(n))); }, "coverage-limit"],
  ["exited process", f => { f.setup.running = false; }, "process-unavailable"],
  ["disconnected client", f => { f.setup.connected = false; }, "connection-unavailable"],
  ["missing owner", f => { f.setup.discovered = false; }, "owner-unavailable"],
  ["missing snapshot", f => { f.setup.snapshot = false; }, "snapshot-timeout"],
  ["unsupported stream", f => { f.setup.version = 99; }, "unsupported-protocol"],
  ["unsupported state", f => { f.setup.conversation = { threadRuntimeStatus: { type: "future" } }; }, "unsupported-state"],
  ["missing state", f => { f.setup.conversation = {}; }, "state-unavailable"],
  ["resuming", f => { f.setup.conversation.resumeState = "resuming"; }, "resuming"],
  ["malformed pending submissions", f => { f.setup.conversation.unconfirmedTurnSubmissions = {}; }, "unsupported-state"],
])("explains %s without erasing the last confirmed observation", async (_name, configure, reason) => {
  const f = fixture();
  try {
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "idle", activityLastKnownAt: 2000 });
    f.setup.now = 3000; configure(f);
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "unknown", activityReason: reason, activityCheckedAt: 3000, activityLastKnownAt: 2000 });
    expect(JSON.stringify(f.rows[0])).not.toContain("private");
  } finally { f.activity.close(); }
});

test("does not diagnose protocol incompatibility from another owner", async () => {
  const f = fixture(); f.setup.foreign = true; f.setup.version = 99;
  try {
    await f.activity.enrich(f.rows);
    expect(f.rows[0].activityReason).toBe("snapshot-timeout");
    expect(f.rows[0].activityLastKnownAt).toBeUndefined();
  } finally { f.activity.close(); }
});

test("null optional pending submissions retain the existing idle interpretation", async () => {
  const f = fixture(); f.setup.conversation.unconfirmedTurnSubmissions = null;
  try {
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "idle", activityLastKnownAt: 2000 });
    expect(f.rows[0].activityReason).toBeUndefined();
  } finally { f.activity.close(); }
});

test("a supported snapshot wins over an earlier unsupported broadcast and clears the reason", async () => {
  const f = fixture(); f.setup.version = 99;
  try {
    await f.activity.enrich(f.rows);
    expect(f.rows[0].activityReason).toBe("unsupported-protocol");
    f.setup.now = 3000; f.setup.sendSupportedAfter = true;
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "idle", activityLastKnownAt: 3000 });
    expect(f.rows[0].activityReason).toBeUndefined();
    expect(f.follow.mock.calls).toEqual([["a", "owner", true], ["a", "owner", false], ["a", "owner", true], ["a", "owner", false]]);
    expect(f.close).toHaveBeenCalledTimes(2);
  } finally { f.activity.close(); }
});

test("incomplete ownership prevents idle but does not hide confirmed working activity", async () => {
  const f = fixture(); f.setup.owners.push(owner("ambiguous"), owner("ambiguous", 99));
  try {
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "unknown", activityReason: "incomplete-mapping" });
    expect(f.rows[0].activityLastKnownAt).toBeUndefined();
    f.setup.conversation = { threadRuntimeStatus: { type: "active", activeFlags: [] } };
    await f.activity.enrich(f.rows);
    expect(f.rows[0]).toMatchObject({ activity: "working", activityLastKnownAt: 2000 });
    expect(f.rows[0].activityReason).toBeUndefined();
  } finally { f.activity.close(); }
});
