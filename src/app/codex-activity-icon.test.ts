import { codexActivityPresentation } from "./codex-activity-icon";
import { CodexInstance } from "../shared/codex-instances";

const instance: CodexInstance = { codexPid: 1, codexStartedAt: "2026-10-24T10:00:00Z", vscodePid: 2,
  vscodeStartedAt: "2026-10-24T09:00:00Z", vscodeMainPid: 3, activity: "idle", activityCheckedAt: 1000 };

test("only displays fresh, recognized activity; expired and future observations are unknown", () => {
  expect(codexActivityPresentation(instance, 31000).label).toBe("Idle");
  expect(codexActivityPresentation(instance, 31001).label).toBe("Unknown");
  expect(codexActivityPresentation(instance, 999).label).toBe("Unknown");
  expect(codexActivityPresentation({ ...instance, activityCheckedAt: undefined }, 1000).label).toBe("Unknown");
  expect(codexActivityPresentation({ ...instance, activity: "future-state" as any }, 1000).label).toBe("Unknown");
});
