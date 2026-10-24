import { CODEX_ACTIVITY_INTERVAL_MS, CodexInstanceService } from "./codex-instance-service";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 2, codexStartedAt: "2026-10-24T10:00:00Z", vscodePid: 1,
  vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 1 };
afterEach(() => jest.useRealTimers());

test("activity refreshes independently of inventory and stops on shutdown", async () => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  const scan = jest.fn(async () => ({ instances: [{ ...instance }] }));
  const activity = { enrich: jest.fn(async (rows: CodexInstance[]) => { rows[0].activity = "idle"; }), close: jest.fn() };
  const service = new CodexInstanceService({ supported: true, scan, activity });
  service.start(); await service.refresh(); await service.refreshActivity();
  expect(service.list().instances[0].activity).toBe("idle");
  jest.advanceTimersByTime(CODEX_ACTIVITY_INTERVAL_MS); await service.refreshActivity();
  expect(scan).toHaveBeenCalledTimes(1); expect(activity.enrich).toHaveBeenCalledTimes(2);
  service.close(); jest.advanceTimersByTime(CODEX_ACTIVITY_INTERVAL_MS);
  expect(activity.close).toHaveBeenCalledTimes(1); expect(activity.enrich).toHaveBeenCalledTimes(2);
});

test("late activity cannot attach to a recycled PID or publish after shutdown", async () => {
  let finish!: () => void;
  const scan = jest.fn().mockResolvedValueOnce({ instances: [{ ...instance }] })
    .mockResolvedValue({ instances: [{ ...instance, codexStartedAt: "2026-10-24T11:00:00Z" }] });
  const service = new CodexInstanceService({ supported: true, scan,
    activity: { enrich: rows => new Promise<void>(resolve => { finish = () => { rows[0].activity = "idle"; resolve(); }; }), close() {} } });
  await service.refresh(); const pending = service.refreshActivity();
  await service.refresh(); finish(); await pending;
  expect(service.list().instances[0].activity).toBeUndefined();
  const listener = jest.fn(); service.onChanged(listener);
  const next = service.refreshActivity(); await Promise.resolve(); service.close(); finish(); await next;
  expect(listener).not.toHaveBeenCalled();
});
