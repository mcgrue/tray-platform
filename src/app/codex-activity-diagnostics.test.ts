import { codexActivityPresentation } from "./codex-activity-icon";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 42, codexStartedAt: new Date(1000).toISOString(),
  vscodePid: 2, vscodeStartedAt: new Date(500).toISOString(), vscodeMainPid: 3,
  activity: "unknown", activityCheckedAt: 2000, activityReason: "owner-unavailable", activityLastKnownAt: 1500 };

test("shows a useful cause and the last confirmed timestamp, without claiming success", () => {
  const result = codexActivityPresentation(instance, 2000);
  expect(result).toMatchObject({ label: "Unknown", reason: "owner-unavailable" });
  expect(result.detail).toContain("owning client is unavailable");
  expect(result.lastConfirmed).toContain(new Date(1500).toLocaleString());
  expect(result.lastConfirmed).not.toContain("success");
});

test("an expired check takes precedence over an old failure reason or idle state", () => {
  for (const activity of ["unknown", "idle"] as const) {
    const result = codexActivityPresentation({ ...instance, activity }, 32001);
    expect(result).toMatchObject({ label: "Unknown", reason: "stale" });
    expect(result.detail).toContain("out of date");
    expect(result.lastConfirmed).toContain(new Date(1500).toLocaleString());
  }
});

test("missing checks and invalid confirmation timestamps have honest fallbacks", () => {
  for (const activityLastKnownAt of [undefined, NaN, Infinity, -1, 3000]) {
    const result = codexActivityPresentation({ ...instance, activityCheckedAt: undefined, activityLastKnownAt }, 2000);
    expect(result).toMatchObject({ reason: "not-checked", lastConfirmed: "No confirmed activity yet." });
  }
});

test("a confirmed active state does not display an obsolete unknown reason", () => {
  const result = codexActivityPresentation({ ...instance, activity: "working" }, 2000);
  expect(result).toMatchObject({ label: "Working", detail: "A conversation is running." });
  expect(result.reason).toBeUndefined();
});
