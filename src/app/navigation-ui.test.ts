import { moveNavigationSelection, navigationItems, navigationSelection } from "./navigation-ui";
import { attentionKey } from "./attention-ui";
import { AttentionItem } from "../shared/attention";
const item = (id: string, createdAt: number, state: AttentionItem["state"] = "pending"): AttentionItem => ({ id, source: "Robot", title: `Build ${id}`, createdAt, updatedAt: createdAt, state });
test("chooser excludes completed items, newest first, filtering title or source case insensitively", () => {
  const items = [item("old", 1), item("new", 5), item("done", 6, "done")];
  expect(navigationItems(items, " ROBOT ").map(entry => entry.id)).toEqual(["new", "old"]);
  expect(navigationItems(items, "build old").map(entry => entry.id)).toEqual(["old"]);
  expect(navigationItems(items, "absent")).toEqual([]);
});
test("selection survives updates, resets safely when selected item disappears and clears with an empty result", () => {
  const items = [item("a", 1), item("b", 2)];
  expect(navigationSelection(items, attentionKey(items[1]))).toBe(attentionKey(items[1]));
  expect(navigationSelection(items.slice(0, 1), attentionKey(items[1]))).toBe(attentionKey(items[0]));
  expect(navigationSelection([], attentionKey(items[1]))).toBeUndefined();
});
test("keyboard movement wraps around without selecting a hidden item", () => {
  const items = [item("a", 1), item("b", 2)];
  expect(moveNavigationSelection(items, attentionKey(items[0]), -1)).toBe(attentionKey(items[1]));
  expect(moveNavigationSelection(items, attentionKey(items[1]), 1)).toBe(attentionKey(items[0]));
  expect(moveNavigationSelection([], undefined, 1)).toBeUndefined();
});
