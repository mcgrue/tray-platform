import { AttentionItem } from "../shared/attention";

export type NavigationDecision = { kind: "empty" } | { kind: "single"; item: AttentionItem } | { kind: "choose"; items: AttentionItem[] };

export function navigationDecision(items: AttentionItem[]): NavigationDecision {
  const pending = items.map((item, index) => ({ item, index }))
    .filter(entry => entry.item.state === "pending")
    .sort((a, b) => b.item.createdAt - a.item.createdAt || a.index - b.index)
    .map(entry => entry.item);
  if (!pending.length) return { kind: "empty" };
  if (pending.length === 1) return { kind: "single", item: pending[0] };
  return { kind: "choose", items: pending };
}
