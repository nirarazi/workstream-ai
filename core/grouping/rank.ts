// core/grouping/rank.ts — What's blocked on the operator, most important first (read only)
//
// The operator's first question (docs/overview.md §1): what am I blocking, and what is blocked that only I can
// unblock? Each ask Needs me by case holds (inbox.ts, v2Inbox) is ranked by three things it can show, in order:
//   1. who it holds up: the actors blocked on the operator in that case, and whoever in the same case is blocked,
//      through them, on those (the wait-for graph, asks.ts), so a block with a queue behind it comes first;
//   2. how many times it has been asked since anything moved the case on;
//   3. how long it has waited.
// Compared in that order, not weighted, so the reason one ranks above another can always be said in a sentence. What
// an ask is worth isn't known from the messages (open question 5); this ranks only what they show. Pure.

import type { Ask } from "./asks.js";
import { ASKS, isOperator, type V2Entry } from "./inbox.js";
import type { LoadedMessage } from "./load.js";
import type { Case } from "./streams.js";

export interface RankedAsk {
  entry: V2Entry;
  /** Actor ids held up: blocked on the operator in this case, or blocked through them in it */
  heldUp: string[];
  /** Asks aimed at the operator since the case last moved on (at least 1) */
  timesAsked: number;
  /** The first of those asks */
  waitingSince: string;
}

/**
 * The asks in front of the operator since the case last moved: walking back from the entry's ask, the asks aimed at
 * the operator, until a message that isn't one (and isn't noise) or the operator's own
 */
function askRun(entry: V2Entry, c: Case | undefined, messages: ReadonlyMap<string, LoadedMessage>, operatorNames: readonly string[]): LoadedMessage[] {
  if (!c || entry.fromReport) return [entry.ask];
  const ms = c.members.map((m) => messages.get(m.key)).filter((m): m is LoadedMessage => m !== undefined && m.at <= entry.ask.at);
  const run: LoadedMessage[] = [];
  for (const m of [...ms].reverse()) {
    if (m.status === "noise") continue;
    if (isOperator(operatorNames, m.senderId, m.senderName)) break;
    if (!ASKS.has(m.status ?? "")) break;
    if (m.targetedAtOperator) run.push(m);
  }
  return run.length ? run.reverse() : [entry.ask];
}

export function rankNeedsYou(
  entries: readonly V2Entry[],
  cases: ReadonlyMap<string, Case>,
  messages: ReadonlyMap<string, LoadedMessage>,
  asks: readonly Ask[],
  opts: { operatorNames: readonly string[]; operatorActors: ReadonlySet<string>; since: string },
): RankedAsk[] {
  // Open blocks from the last while, by case
  const live = new Map<string, Ask[]>();
  for (const a of asks) {
    if (a.strength !== "blocks" || a.answeredAt || a.at < opts.since || !a.caseId) continue;
    const xs = live.get(a.caseId);
    if (xs) xs.push(a);
    else live.set(a.caseId, [a]);
  }
  const ranked = entries.map((entry): RankedAsk => {
    const run = askRun(entry, cases.get(entry.caseId), messages, opts.operatorNames);
    const blocks = live.get(entry.caseId) ?? [];
    // Blocked on the operator in this case: open blocks to them, and the sender of a blocking ask aimed at them
    const direct = new Set(blocks.filter((a) => opts.operatorActors.has(a.to)).map((a) => a.from));
    // (an ask older than the window holds no one up any more: it's stale, as open blocks are)
    for (const m of run) if (m.senderId && m.at >= opts.since) direct.add(m.senderId);
    // And whoever is blocked on those in the same case, however far back. Only the same case: someone blocked on one
    // of them over other work isn't waiting on this ask
    const waitingOn = new Map<string, Set<string>>();
    for (const a of blocks) waitingOn.set(a.to, (waitingOn.get(a.to) ?? new Set()).add(a.from));
    const held = new Set(direct);
    const queue = [...direct];
    while (queue.length) {
      for (const w of waitingOn.get(queue.shift()!) ?? []) {
        if (held.has(w)) continue;
        held.add(w);
        queue.push(w);
      }
    }
    for (const id of opts.operatorActors) held.delete(id);
    return { entry, heldUp: [...held].sort(), timesAsked: run.length, waitingSince: run[0].at };
  });
  return ranked.sort((x, y) =>
    y.heldUp.length - x.heldUp.length
    || y.timesAsked - x.timesAsked
    || (x.waitingSince < y.waitingSince ? -1 : x.waitingSince > y.waitingSince ? 1 : 0)
    || (x.entry.caseId < y.entry.caseId ? -1 : 1));
}

/** Why it ranks where it does, in words: "holds up Atlas and Relay · asked 3 times · waiting 5 days" */
export function rankReason(r: RankedAsk, now: string, name: (actor: string) => string): string {
  const parts: string[] = [];
  if (r.heldUp.length) {
    const names = r.heldUp.map(name);
    parts.push(`holds up ${names.length <= 3 ? names.join(", ").replace(/, ([^,]*)$/, " and $1") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`}`);
  }
  if (r.timesAsked > 1) parts.push(`asked ${r.timesAsked} times`);
  parts.push(`waiting ${ago(r.waitingSince, now)}`);
  return parts.join(" · ");
}

/** "3 days", "5 hours", "under an hour" */
export function ago(at: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 3_600_000) return "under an hour";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
