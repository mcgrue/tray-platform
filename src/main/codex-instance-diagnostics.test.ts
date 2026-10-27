import { CodexInstanceService } from "./codex-instance-service";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 42, codexStartedAt: new Date(1000).toISOString(),
  vscodePid: 2, vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 3 };

test("retains confirmed activity across scans and failures, but never across PID reuse", async () => {
  let now = 2000, fail = false, current = { ...instance };
  const service = new CodexInstanceService({ supported: true, now: () => now,
    scan: async () => ({ instances: [{ ...current }] }),
    activity: { close() {}, enrich: async rows => {
      if (fail) throw Error("private error");
      rows[0].activity = "idle"; rows[0].activityCheckedAt = now; rows[0].activityLastKnownAt = now;
      delete rows[0].activityReason;
    } },
  });
  try {
    await service.refresh(); await service.refreshActivity();
    expect(service.list().instances[0].activityLastKnownAt).toBe(2000);
    fail = true; now = 3000;
    await service.refresh(); await service.refreshActivity();
    expect(service.list().instances[0]).toMatchObject({ activity: "unknown", activityReason: "check-failed", activityLastKnownAt: 2000 });
    current = { ...current, codexStartedAt: new Date(2500).toISOString() };
    await service.refresh(); await service.refreshActivity();
    expect(service.list().instances[0].activityLastKnownAt).toBeUndefined();
    fail = false; now = 4000; await service.refreshActivity();
    expect(service.list().instances[0]).toMatchObject({ activity: "idle", activityLastKnownAt: 4000 });
    expect(service.list().instances[0].activityReason).toBeUndefined();
  } finally { service.close(); }
});

test("publishes diagnostic fields with the same process identity guard as activity", async () => {
  let finish!: () => void;
  let current = { ...instance };
  const service = new CodexInstanceService({ supported: true, scan: async () => ({ instances: [{ ...current }] }),
    activity: { close() {}, enrich: rows => new Promise<void>(resolve => { finish = () => {
      rows[0].activity = "unknown"; rows[0].activityReason = "owner-unavailable"; rows[0].activityLastKnownAt = 1500; resolve();
    }; }) },
  });
  try {
    await service.refresh(); const pending = service.refreshActivity();
    await Promise.resolve(); finish(); await pending;
    expect(service.list().instances[0]).toMatchObject({ activityReason: "owner-unavailable", activityLastKnownAt: 1500 });
    const stale = service.refreshActivity(); await Promise.resolve();
    current = { ...instance, codexStartedAt: new Date(3000).toISOString() };
    await service.refresh(); finish(); await stale;
    expect(service.list().instances[0].activityReason).toBeUndefined();
    expect(service.list().instances[0].activityLastKnownAt).toBeUndefined();
  } finally { service.close(); }
});
