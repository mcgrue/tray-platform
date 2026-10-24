import { aggregateCodexActivity, codexThreadActivity, CodexActivity, currentCodexThreads } from "./codex-activity";
import { CodexInstance } from "../shared/codex-instances";
import { CodexTurnOwner } from "./workspace-file-updates";

const instance: CodexInstance = { codexPid: 42, codexStartedAt: new Date(1000).toISOString(), vscodePid: 2,
  vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 3 };
const owner = (threadId = "thread-a", extras: Partial<CodexTurnOwner> = {}): CodexTurnOwner => ({
  threadId, turnId: "turn-a", processIdentity: "pid:42:process-a", firstObservedAt: 1100,
  lastObservedAt: 1200, rolloutPath: "C:\\sessions\\a.jsonl", ...extras,
});

test("uses explicit native states, including pending admission and both blocking flags", () => {
  const state = (type: string, activeFlags?: string[]) => codexThreadActivity({ threadRuntimeStatus: { type, activeFlags } });
  expect(state("idle")).toBe("idle");
  expect(state("active", [])).toBe("working");
  expect(state("active", ["waitingOnApproval"])).toBe("waiting");
  expect(state("active", ["waitingOnUserInput"])).toBe("waiting");
  for (const type of ["notLoaded", "systemError", "future-state"]) expect(state(type)).toBe("unknown");
  expect(state("active")).toBe("unknown");
  expect(state("active", ["future-flag"])).toBe("unknown");
  expect(codexThreadActivity({ threadRuntimeStatus: { type: "idle" }, unconfirmedTurnSubmissions: [{}] })).toBe("working");
  expect(codexThreadActivity({ threadRuntimeStatus: { type: "idle" }, resumeState: "resuming" })).toBe("unknown");
  expect(codexThreadActivity({ turns: [{ status: "completed" }] })).toBe("unknown");
});

test("aggregates concurrent conversations without calling missing evidence idle", () => {
  expect(aggregateCodexActivity(["idle", "working", "waiting"])).toBe("working");
  expect(aggregateCodexActivity(["idle", "waiting"])).toBe("waiting");
  expect(aggregateCodexActivity(["idle", "unknown"])).toBe("unknown");
  expect(aggregateCodexActivity([])).toBe("unknown");
  expect(aggregateCodexActivity(["idle", "idle"])).toBe("idle");
});

test("rejects recycled PIDs, ambiguous execution and future observations; honors thread takeover", () => {
  const other = { ...instance, codexPid: 99 };
  const entries = [owner("old-pid", { firstObservedAt: 999 }), owner("future", { lastObservedAt: 2100 }),
    owner("ambiguous"), owner("ambiguous", { processIdentity: "pid:99:other" }), owner("taken-over"),
    owner("taken-over", { processIdentity: "pid:99:other", lastObservedAt: 1300 }), owner("current")];
  const mapped = currentCodexThreads([instance, other], entries, 2000);
  expect([...mapped.keys()].sort()).toEqual(["current", "taken-over"]);
  expect(mapped.get("taken-over")!.processIdentity).toBe("pid:99:other");
});

function fixture(options: { missing?: boolean; disconnected?: boolean; unavailableOwners?: boolean } = {}) {
  const rows = [{ ...instance }];
  const follow = jest.fn(), close = jest.fn(), request = jest.fn();
  const activity = new CodexActivity({ now: () => 2000, snapshotTimeoutMs: 5,
    readOwners: async () => { if (options.unavailableOwners) throw Error("missing DB"); return [owner()]; },
    createClient: notify => {
      request.mockImplementation(async method => ({ method, resultType: "success", handledByClientId: "owner" }));
      follow.mockImplementation((id, source, following) => {
        if (!following || options.missing) return;
        // Wrong owner/version/host may not satisfy the subscription.
        const message = { type: "broadcast" as const, method: "thread-stream-state-changed", sourceClientId: source,
          version: 11, params: { hostId: "local", conversationId: id,
            change: { type: "snapshot", conversationState: { id, threadRuntimeStatus: { type: "idle" } } } } };
        notify({ ...message, sourceClientId: "other" });
        notify({ ...message, version: 99 });
        notify({ ...message, params: { ...message.params, hostId: "remote" } });
        notify({ ...message, params: { ...message.params, change: { ...message.params.change,
          conversationState: { id, threadRuntimeStatus: { type: "active", activeFlags: [] } } } } });
      });
      return { connect: async () => { if (options.disconnected) throw Error("disconnected"); }, request, followThread: follow, close };
    },
  });
  return { rows, activity, follow, close, request };
}

test("reads owner-targeted status snapshots and releases every read-only subscription", async () => {
  const f = fixture(); await f.activity.enrich(f.rows);
  expect(f.rows[0]).toMatchObject({ activity: "working", activityCheckedAt: 2000 });
  expect(f.request).toHaveBeenCalledWith("thread-owner-discovery", { hostId: "local", conversationId: "thread-a" }, 1);
  expect(f.follow.mock.calls).toEqual([["thread-a", "owner", true], ["thread-a", "owner", false]]);
  expect(f.close).toHaveBeenCalledTimes(1);
  f.activity.close();
});

test.each([{ missing: true }, { disconnected: true }, { unavailableOwners: true }])("unavailable evidence clears an earlier idle result: %j", async options => {
  const f = fixture(options); f.rows[0].activity = "idle";
  await f.activity.enrich(f.rows);
  expect(f.rows[0].activity).toBe("unknown"); f.activity.close();
});

test("one exited process cannot keep other instances from reporting their verified state", async () => {
  const rows = [{ ...instance }, { ...instance, codexPid: 99 }];
  const checked: number[][] = [];
  const activity = new CodexActivity({ now: () => 2000,
    readOwners: async () => [owner(), owner("thread-b", { processIdentity: "pid:99:other" })],
    verifyProcesses: async candidates => { checked.push(candidates.map(row => row.codexPid)); return candidates.every(row => row.codexPid === 99); },
    createClient: notify => ({ connect: async () => {}, close() {},
      request: async method => ({ type: "response", requestId: "id", method, resultType: "success", handledByClientId: "owner" }),
      followThread: (id, source, following) => { if (following) notify({ type: "broadcast", method: "thread-stream-state-changed",
        version: 11, sourceClientId: source, params: { hostId: "local", conversationId: id,
          change: { type: "snapshot", conversationState: { id, threadRuntimeStatus: { type: "idle" } } } } }); },
    }),
  });
  await activity.enrich(rows);
  expect(rows.map(row => row.activity)).toEqual(["unknown", "idle"]);
  expect(checked).toEqual([[42, 99], [42], [99]]);
  activity.close();
});
