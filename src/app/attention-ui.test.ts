import { attentionKey, urlDestination, visibleAttentionItems } from "./attention-ui";
import { AttentionItem } from "../shared/attention";

function item(id: string, createdAt: number, state: AttentionItem["state"] = "pending"): AttentionItem {
  return { id, source: "robot", title: id, state, createdAt, updatedAt: createdAt };
}

describe("attention inbox presentation", () => {
  test("filters each disposition and orders by creation rather than robot updates without mutating the snapshot", () => {
    const older = { ...item("older", 1), updatedAt: 500 };
    const items = [older, item("done", 4, "done"), item("newer", 3)];
    expect(visibleAttentionItems(items, "pending").map(entry => entry.id)).toEqual(["newer", "older"]);
    expect(visibleAttentionItems(items, "done").map(entry => entry.id)).toEqual(["done"]);
    expect(items[0]).toBe(older);
  });

  test("ties have a stable source and ID ordering", () => {
    expect(visibleAttentionItems([item("b", 1), item("a", 1)], "pending").map(entry => entry.id)).toEqual(["a", "b"]);
  });

  test("caller identifiers with separators cannot alias another inbox card", () => {
    expect(attentionKey({ source: "a:b", id: "c" })).not.toBe(attentionKey({ source: "a", id: "b:c" }));
  });

  test("accepts only complete HTTP(S) links", () => {
    expect(urlDestination(" https://example.com/path?q=robot ")).toEqual({ kind: "url", url: "https://example.com/path?q=robot" });
    expect(urlDestination("http://localhost:1234/").url).toBe("http://localhost:1234/");
    ["javascript:alert(1)", "file:///C:/secret", "example.com", ""].forEach(value => expect(() => urlDestination(value)).toThrow());
  });
});
