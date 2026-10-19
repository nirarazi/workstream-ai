// core/grouping/streams.ts — Cases from the grouping's placements, and the streams that hold them (docs/work-model.md)
//
// A case is a cluster of messages. A stream holds many cases: a subject's (a partner, a customer) when a case is about
// one, else a ticket project's, else releases, else its channel's. Pure.

import type { Placement } from "./cluster.js";

export interface CaseMember {
  key: string;
  at: string;
  via: string | null;
  reasons: string[];
}

export interface Case {
  id: string;
  /** The keys its messages are about, most named first */
  keys: string[];
  stream: string;
  members: CaseMember[];
  first: string;
  last: string;
}

export interface Stream {
  key: string;
  cases: string[];
  messages: number;
  last: string;
}

/** The stream a case belongs to */
export function streamOf(keys: readonly string[], channelId: string | null): string {
  const subject = keys.find((k) => k.startsWith("subject:"));
  if (subject) return subject;
  const ticket = keys.find((k) => k.startsWith("ticket:"));
  if (ticket) return `project:${ticket.slice("ticket:".length).replace(/-\d+$/, "")}`;
  if (keys.some((k) => k.startsWith("release:"))) return "releases";
  const record = keys.find((k) => k.startsWith("record:"));
  if (record) return `records:${record.slice("record:".length).split("#")[0]}`;
  return `channel:${channelId ?? "?"}`;
}

export function casesFrom(
  placements: ReadonlyMap<string, Placement>,
  info: ReadonlyMap<string, { at: string; channelId: string | null }>,
): { cases: Case[]; streams: Stream[] } {
  const byCase = new Map<string, CaseMember[]>();
  for (const [key, p] of placements) {
    if (!p.cluster) continue;
    const at = info.get(key)?.at ?? "";
    byCase.set(p.cluster, [...(byCase.get(p.cluster) ?? []), { key, at, via: p.via, reasons: p.reasons }]);
  }
  const cases: Case[] = [];
  for (const [id, members] of byCase) {
    members.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const counts = new Map<string, number>();
    for (const m of members) {
      const about = placements.get(m.key)!.recognized.about;
      if (about) counts.set(about, (counts.get(about) ?? 0) + 1);
    }
    const keys = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
    const channelId = info.get(members[0].key)?.channelId ?? null;
    cases.push({ id, keys, stream: streamOf(keys, channelId), members, first: members[0].at, last: members[members.length - 1].at });
  }
  const byStream = new Map<string, Stream>();
  for (const c of cases) {
    const s = byStream.get(c.stream) ?? { key: c.stream, cases: [], messages: 0, last: "" };
    s.cases.push(c.id);
    s.messages += c.members.length;
    if (c.last > s.last) s.last = c.last;
    byStream.set(c.stream, s);
  }
  const streams = [...byStream.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  return { cases: cases.sort((a, b) => (a.last < b.last ? 1 : -1)), streams };
}
