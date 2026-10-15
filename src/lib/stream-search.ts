import type { ActionableItem } from "./api";

/** Case-insensitive match on everything shown for an item: ID, title, agent, channel and latest message. */
export function matchesSearch(item: ActionableItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    item.workItem.id,
    item.workItem.title,
    item.agent?.name,
    item.thread?.channelName,
    item.latestEvent?.rawText,
    item.latestEvent?.reason,
  ].filter(Boolean).join("\n").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}
