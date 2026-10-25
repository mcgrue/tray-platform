import { AttentionItem } from "../shared/attention";
import { navigationDecision } from "./navigation";

function item(id: string, createdAt: number, state: AttentionItem["state"] = "pending"): AttentionItem {
  return { id, source: "test", title: id, createdAt, updatedAt: createdAt, state };
}

test("zero pending items yields the empty inbox", () => {
  expect(navigationDecision([])).toEqual({ kind: "empty" });
  expect(navigationDecision([item("done", 100, "done"), item("finished", 200, "done")])).toEqual({ kind: "empty" });
});
test("one pending item yields that item regardless of destination", () => {
  const pending = item("pending", 100);
  expect(navigationDecision([item("done", 200, "done"), pending])).toEqual({ kind: "single", item: pending });
});
test("multiple pending items choose newest first with stable ties and no input mutation", () => {
  const older = item("old", 100), first = item("first", 200), second = item("second", 200);
  const items = [older, first, item("done", 300, "done"), second];
  expect(navigationDecision(items)).toEqual({ kind: "choose", items: [first, second, older] });
  expect(items[0]).toBe(older); expect(items[1]).toBe(first); expect(items[3]).toBe(second);
});
