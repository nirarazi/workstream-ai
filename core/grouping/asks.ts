// core/grouping/asks.ts — Who is waiting on whom: asks between actors, and the wait-for graph (docs/work-model.md §3)
//
// An ask is a message that asks someone for something:
//   - the classifier says it's blocked on someone or waiting on a decision, and names who (events.action_required_from);
//   - or it mentions someone (<@U…>) and asks: a question, or a request word ("please", "can you", "approve", …).
// It's answered when the one asked posts later in the same case (or, for a message in no case, the same thread).
// Open asks are edges of the wait-for graph, from the one waiting to the one waited on. On it: who is waited on most
// (a bottleneck), cycles (A waits on B, who waits on A: a deadlock), and each actor's root blocker (follow who they
// wait on until someone waits on nobody). Read-only analysis: nothing here surfaces anything or changes a case.

import type { Placement } from "./cluster.js";
import type { LoadedMessage } from "./load.js";
import { stripSignature } from "./recognize.js";

export interface Ask {
  /**
   * blocks: the classifier says the sender is blocked on, or waiting for a decision from, the one asked; asks: a
   * mention with a request or a question, which may or may not hold anything up
   */
  strength: "blocks" | "asks";
  message: string;
  caseId: string | null;
  from: string;
  to: string;
  at: string;
  answeredAt: string | null;
  answeredBy: string | null;
}

const MENTION = /<@([A-Z0-9]+)(?:\|[^<>]*)?>/g;
const REQUEST = /\b(?:please|pls|can you|could you|would you|need you to|approve|review|check|confirm|send|fix|merge|decide|let me know)\b/i;

/** Actor ids a message's "action required from" names: ids as they are, names looked up (case-insensitive) */
function resolveActors(names: readonly string[], byName: ReadonlyMap<string, string>, known: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const id = known.has(n) ? n : byName.get(n.trim().toLowerCase());
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Pure. Asks in the messages, each marked answered when the one asked posted later in its case (or thread). `byName`
 * maps actors' display names (lower-cased) to their ids.
 */
export function findAsks(
  messages: readonly LoadedMessage[],
  placements: ReadonlyMap<string, Placement>,
  byName: ReadonlyMap<string, string>,
): Ask[] {
  const sorted = [...messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const known = new Set(messages.map((m) => m.senderId).filter((x): x is string => Boolean(x)));
  for (const id of byName.values()) known.add(id);
  const asks: Ask[] = [];
  const open = new Map<string, Ask[]>(); // by "<scope>|<to>"
  const scopeOf = (m: LoadedMessage) => placements.get(m.key)?.cluster ?? `thread:${m.threadId}`;
  for (const m of sorted) {
    const scope = scopeOf(m);
    // A post by someone answers what was asked of them in the same case
    if (m.senderId) {
      for (const a of open.get(`${scope}|${m.senderId}`) ?? []) {
        a.answeredAt = m.at;
        a.answeredBy = m.key;
      }
      open.delete(`${scope}|${m.senderId}`);
    }
    if (!m.senderId) continue;
    const targets = new Map<string, Ask["strength"]>();
    const text = stripSignature(m.text);
    const mentioned = [...text.matchAll(MENTION)].map((x) => x[1]);
    // A mention asks only someone the fleet knows (a person or agent who posts, or is in the directory): a tool's
    // handle in a sign-off or a link isn't someone to wait on
    if (mentioned.length > 0 && (text.includes("?") || REQUEST.test(text))) for (const id of mentioned) if (known.has(id)) targets.set(id, "asks");
    if ((m.status === "blocked_on_human" || m.status === "needs_decision") && m.actionRequiredFrom?.length) {
      for (const id of resolveActors(m.actionRequiredFrom, byName, known)) targets.set(id, "blocks");
    }
    targets.delete(m.senderId);
    for (const [to, strength] of targets) {
      const ask: Ask = { strength, message: m.key, caseId: placements.get(m.key)?.cluster ?? null, from: m.senderId, to, at: m.at, answeredAt: null, answeredBy: null };
      asks.push(ask);
      open.set(`${scope}|${to}`, [...(open.get(`${scope}|${to}`) ?? []), ask]);
    }
  }
  return asks;
}

export interface WaitFor {
  /** Actors waited on, most open asks first; `blocking` of them are blocks */
  waitedOn: Array<{ actor: string; open: number; blocking: number; by: string[]; oldest: string }>;
  /** Groups of actors each waiting, through the others, on themselves */
  cycles: string[][];
  /** For each actor waiting on someone, who the chain of waiting ends at */
  rootBlockers: Array<{ actor: string; root: string; path: string[] }>;
}

/**
 * Pure. The wait-for graph of the asks still open, made at or after `since` (older ones are stale, not waiting).
 * Cycles and root blockers follow blocks only: in a busy fleet people ask each other things all the time, and only
 * being blocked makes waiting a chain.
 */
export function waitFor(asks: readonly Ask[], since: string): WaitFor {
  const live = asks.filter((a) => !a.answeredAt && a.at >= since);
  const edges = new Map<string, Set<string>>();
  const waited = new Map<string, { open: number; blocking: number; by: Set<string>; oldest: string }>();
  for (const a of live) {
    if (a.strength === "blocks") edges.set(a.from, (edges.get(a.from) ?? new Set()).add(a.to));
    const w = waited.get(a.to) ?? { open: 0, blocking: 0, by: new Set<string>(), oldest: a.at };
    w.open++;
    if (a.strength === "blocks") w.blocking++;
    w.by.add(a.from);
    if (a.at < w.oldest) w.oldest = a.at;
    waited.set(a.to, w);
  }
  const waitedOn = [...waited].map(([actor, w]) => ({ actor, open: w.open, blocking: w.blocking, by: [...w.by], oldest: w.oldest }))
    .sort((x, y) => y.blocking - x.blocking || y.open - x.open || (x.oldest < y.oldest ? -1 : 1));

  // Cycles: strongly connected components of more than one actor (Tarjan)
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) cycles.push(scc.sort());
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);

  // Root blockers: follow the most-waited-on target until an actor waits on nobody, or a cycle closes
  const rootBlockers: WaitFor["rootBlockers"] = [];
  const weight = (a: string) => waited.get(a)?.blocking ?? 0;
  for (const actor of edges.keys()) {
    const path = [actor];
    let at = actor;
    while (edges.has(at)) {
      const nextActor = [...edges.get(at)!].sort((x, y) => weight(y) - weight(x) || (x < y ? -1 : 1))[0];
      if (path.includes(nextActor)) break;
      path.push(nextActor);
      at = nextActor;
    }
    if (path.length > 1) rootBlockers.push({ actor, root: path[path.length - 1], path });
  }
  return { waitedOn, cycles, rootBlockers };
}
