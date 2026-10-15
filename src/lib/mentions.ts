import type { Mentionable } from "./api";

/** Filter mentionables by query */
export function filterMentionables(mentionables: Mentionable[], query: string): Mentionable[] {
  const q = query.toLowerCase();
  return q
    ? mentionables.filter((m) => m.name.toLowerCase().includes(q))
    : mentionables;
}
