// core/grouping/inbox.ts — Needs me by case: which v2 cases put an ask in front of the operator (read only)
//
// The rule Needs me applies to items, applied to the v2 grouping's cases (v2Inbox), and what it reads from the database
// beyond the grouping (loadInboxState): each event's confidence and item, the operator's own state on each item, and
// the report lines that escalate an item. npm run eval:inbox-diff scores it against Needs me as it is; the Overview
// (docs/overview.md) shows it as "needs you". Nothing here writes.

import type BetterSqlite3 from "better-sqlite3";
import type { LoadedMessage } from "./load.js";
import type { Case } from "./streams.js";

export const ASKS: ReadonlySet<string> = new Set(["blocked_on_human", "needs_decision"]);

/** What v2 needs from the database beyond the grouping: per event, its confidence and the item it was filed under */
export interface EventInfo {
  confidence: number;
  workItemId: string | null;
}

/** The operator's own state on an item, which v2 honours for the ask that item surfaced */
export interface ItemState {
  status: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  mergedInto: string | null;
  /**
   * The operator's latest action in the app that takes an item out of Needs me (approve, unblock, close, noise), and
   * when: recorded on the item, not as a message v2 groups
   */
  actedOnByOperator: { action: string; at: string } | null;
}

export interface V2Entry {
  caseId: string;
  /** The ask that puts the case in front of the operator: its latest blocking message aimed at them */
  ask: LoadedMessage;
  itemId: string | null;
  /** The ask is a report's line about this case (a digest escalating one of the items it lists), not a member */
  fromReport: boolean;
}

/** A report's line escalating an item to the operator, placed on the case that holds the item's key */
export interface Escalation {
  message: LoadedMessage;
  itemId: string;
}

export interface V2Inbox {
  entries: V2Entry[];
  /** Cases not surfaced, with why, for cases that would have been surfaced but for the operator or a handoff */
  held: Map<string, Held>;
}

export type Held = "dismissed" | "snoozed" | "handed off" | "acted on by the operator" | "its item is noise";

function latestOf(xs: readonly Escalation[]): Escalation | undefined {
  return xs.reduce<Escalation | undefined>((best, x) => (!best || x.message.at > best.message.at ? x : best), undefined);
}

/**
 * Whether a name or id is the operator's: exactly one of `names`, case-insensitive, as getActionableItems matches them
 * (`names` already holds each name's first word, from operatorNames)
 */
export function isOperator(names: readonly string[], ...ids: Array<string | null | undefined>): boolean {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return ids.some((id) => id && lower.has(id.trim().toLowerCase()));
}

/** What the operator did to an item since an ask, that holds the ask back as it holds the item back today */
export function heldByOperator(item: ItemState | undefined, askAt: string, now: string): Held | null {
  if (!item) return null;
  if (item.snoozedUntil && item.snoozedUntil > now) return "snoozed";
  if (item.dismissedAt && item.dismissedAt >= askAt) return "dismissed";
  if (item.actedOnByOperator && item.actedOnByOperator.at >= askAt) return "acted on by the operator";
  return null;
}

/**
 * Pure. Needs me by case, by the rules Needs me applies to items: a case is waiting when its latest message that isn't
 * noise is blocked or waiting on a decision; it's surfaced when its latest such message aimed at the operator (not
 * theirs) is its ask, and no later blocking message hands it to someone else (aimed elsewhere, at `handoff`
 * confidence or above, not naming the operator). What the operator did to the item that ask was filed under holds it
 * back, as it holds that item back today: a snooze, a dismissal, or an action on it (approve, unblock, close, noise)
 * since the ask. Stricter than Needs me in one way: the ask itself must block or wait on a decision, where an item
 * that's waiting surfaces with its latest message aimed at the operator, whatever that message's status.
 * Reports join no case, but a report's line can escalate one item it lists (event_targets): `escalations` places those
 * on the cases holding the items' keys, where each is an ask like a member's, unless a member moved the case on since;
 * one for an item no case holds (only reports name it) is keyed "item:<id>" and is an entry of its own, decided by its
 * item's status (handoffs in reports aren't read: rare, as only reports name these items).
 */
export function v2Inbox(
  cases: readonly Case[],
  messages: ReadonlyMap<string, LoadedMessage>,
  events: ReadonlyMap<string, EventInfo>,
  items: ReadonlyMap<string, ItemState>,
  escalations: ReadonlyMap<string, readonly Escalation[]>,
  opts: { operatorNames: readonly string[]; handoff: number; now: string },
): V2Inbox {
  const entries: V2Entry[] = [];
  const held = new Map<string, Held>();
  // A case's report lines whose items the operator hasn't held back since: of several, the latest is its ask
  const openEscalation = (id: string) =>
    latestOf((escalations.get(id) ?? []).filter((e) => !heldByOperator(items.get(e.itemId), e.message.at, opts.now)));
  for (const c of cases) {
    const ms = c.members.map((m) => messages.get(m.key)).filter((m): m is LoadedMessage => m !== undefined);
    const fromOperator = (m: LoadedMessage) => isOperator(opts.operatorNames, m.senderId, m.senderName);
    const own = [...ms].reverse().find((m) => ASKS.has(m.status ?? "") && m.targetedAtOperator && !fromOperator(m));
    const escalated = openEscalation(c.id);
    const fromReport = escalated !== undefined && (!own || escalated.message.at > own.at);
    const ask = fromReport ? escalated.message : own;
    if (!ask) {
      // Only report lines, each held back by what the operator did to its item
      const all = latestOf(escalations.get(c.id) ?? []);
      const why = all ? heldByOperator(items.get(all.itemId), all.message.at, opts.now) : null;
      if (why) held.set(c.id, why);
      continue;
    }
    // Waiting while nothing since the ask moved the case on (a member that isn't noise and doesn't ask)
    const since = ms.filter((m) => m.at > ask.at && m.status !== "noise");
    if (since.some((m) => !ASKS.has(m.status ?? ""))) continue;
    const handedOff = since.some((m) => !m.targetedAtOperator
      && (events.get(m.eventId)?.confidence ?? 0) >= opts.handoff
      && !(m.actionRequiredFrom ?? []).some((n) => isOperator(opts.operatorNames, n)));
    if (handedOff) {
      held.set(c.id, "handed off");
      continue;
    }
    // The item the ask was filed under. A message filed in two threads is one message to v2, and its row may name
    // the other thread's item, whose state is then the one read
    const itemId = fromReport ? escalated.itemId : events.get(ask.eventId)?.workItemId ?? null;
    const item = itemId ? items.get(itemId) : undefined;
    const why = heldByOperator(item, ask.at, opts.now);
    if (why) {
      held.set(c.id, why);
      continue;
    }
    // Set aside without the operator: an item only a notification bot posted in
    if (item?.status === "noise") {
      held.set(c.id, "its item is noise");
      continue;
    }
    entries.push({ caseId: c.id, ask, itemId, fromReport });
  }
  // An item only reports name has no case: its latest escalated line is an entry of its own, keyed by the item
  const caseIds = new Set(cases.map((c) => c.id));
  for (const [id, xs] of escalations) {
    if (caseIds.has(id)) continue;
    const e = latestOf(xs)!;
    const item = items.get(e.itemId);
    // No case to say whether it moved on since: the item's own status says
    if (item && !ASKS.has(item.status ?? "")) continue;
    const why = heldByOperator(item, e.message.at, opts.now);
    if (why) held.set(id, why);
    else entries.push({ caseId: id, ask: e.message, itemId: e.itemId, fromReport: true });
  }
  return { entries, held };
}

/** What v2Inbox reads beyond the grouping, with each event's message key and time */
export interface InboxState {
  events: Map<string, EventInfo & { key: string; at: string }>;
  items: Map<string, ItemState>;
  escalations: Map<string, Escalation[]>;
}

/**
 * The events, the operator's state on each item, and the report lines escalating an item, placed on the cases holding
 * the item's live keys (or "item:<id>" when none does), for v2Inbox. Reads only.
 */
export function loadInboxState(db: BetterSqlite3.Database, cases: readonly Case[], messages: readonly LoadedMessage[]): InboxState {
  const byKey = new Map(messages.map((m) => [m.key, m]));
  const events = new Map<string, EventInfo & { key: string; at: string }>();
  for (const r of db.prepare(`
    SELECT e.id, e.confidence, e.work_item_id, e.message_id, e.timestamp, t.platform, t.channel_id
    FROM events e LEFT JOIN threads t ON t.id = e.thread_id
  `).all() as Array<{ id: string; confidence: number | null; work_item_id: string | null; message_id: string; timestamp: string; platform: string | null; channel_id: string | null }>) {
    events.set(r.id, {
      confidence: r.confidence ?? 0, workItemId: r.work_item_id, at: r.timestamp,
      key: `${r.platform ?? "unknown"}:${r.channel_id ?? ""}:${r.message_id}`,
    });
  }
  // The operator's actions in the app are events with no sender, labelled by action (core/server.ts, /api/action):
  // the ones that take an item out of Needs me. Snoozes and dismissals from the stream are on the item itself
  const acted = new Map<string, { action: string; at: string }>();
  for (const r of db.prepare(`
    SELECT work_item_id, reason, MAX(timestamp) AS at FROM events
    WHERE agent_id IS NULL AND work_item_id IS NOT NULL
      AND reason IN ('Operator approved', 'Operator unblocked', 'Operator dismissed', 'Operator classified as noise')
    GROUP BY work_item_id
  `).all() as Array<{ work_item_id: string; reason: string; at: string }>) acted.set(r.work_item_id, { action: r.reason, at: r.at });
  const items = new Map<string, ItemState>();
  for (const r of db.prepare("SELECT id, current_atc_status, snoozed_until, dismissed_at, merged_into FROM work_items").all() as Array<{
    id: string; current_atc_status: string | null; snoozed_until: string | null; dismissed_at: string | null; merged_into: string | null;
  }>) {
    items.set(r.id, {
      status: r.current_atc_status, snoozedUntil: r.snoozed_until, dismissedAt: r.dismissed_at, mergedInto: r.merged_into,
      actedOnByOperator: acted.get(r.id) ?? null,
    });
  }

  // A report's escalated lines, on the cases holding each item's live keys
  const caseOfKeyName = new Map<string, string>();
  for (const c of [...cases].sort((x, y) => (x.last < y.last ? -1 : 1))) for (const k of c.keys) caseOfKeyName.set(k, c.id);
  const keysOf = new Map<string, string[]>();
  for (const r of db.prepare("SELECT key, item_id FROM item_keys WHERE retired_at IS NULL").all() as Array<{ key: string; item_id: string }>) {
    const ks = keysOf.get(r.item_id);
    if (ks) ks.push(r.key);
    else keysOf.set(r.item_id, [r.key]);
  }
  const byEvent = new Map(messages.map((m) => [m.eventId, m]));
  const escalations = new Map<string, Escalation[]>();
  for (const r of db.prepare("SELECT event_id, work_item_id FROM event_targets").all() as Array<{ event_id: string; work_item_id: string }>) {
    const key = events.get(r.event_id)?.key;
    const message = byEvent.get(r.event_id) ?? (key ? byKey.get(key) : undefined);
    if (!message) continue;
    // No case holds the item's keys (reports alone name it): an entry of its own, "item:<id>"
    const caseId = (keysOf.get(r.work_item_id) ?? []).map((k) => caseOfKeyName.get(k)).find(Boolean) ?? `item:${r.work_item_id}`;
    const xs = escalations.get(caseId);
    if (xs) xs.push({ message, itemId: r.work_item_id });
    else escalations.set(caseId, [{ message, itemId: r.work_item_id }]);
  }
  return { events, items, escalations };
}
