#!/usr/bin/env node
// core/eval/inbox-diff.ts — Needs me as it is, beside Needs me as the v2 grouping would make it (read only)
//
// Usage: npm run eval:inbox-diff -- [--db workstream.db] [--operator "Dana,U0DANA"]
// Plan step 7's question (docs/work-model.md §9): would cutting over to the v2 grouping (core/grouping/) interrupt the
// operator less, or for the wrong things? From a read-only copy of the database it takes Needs me as the engine
// serves it (ContextGraph.getActionableItems) and Needs me by case under v2 (v2Inbox below), then lines them up:
//   both       an item and a case surfacing the same ask
//   live only  an item Needs me shows that v2 wouldn't, and why (its message isn't work to v2, its case moved on
//              since, or someone else has it now)
//   v2 only    a case v2 would surface that Needs me doesn't, and why (its item is done, merged, or never was one)
//   merged     several items that v2 holds in one case: fewer entries, or unrelated asks hidden behind one
//   split      an item Needs me shows once that v2 would show as several cases: more entries
// It prints counts and writes the entries, with a few words of each message, to eval-data/inbox-diff/report.md.
// --operator names the operator (names or ids, comma-separated) for handoffs and their own messages; by default the
// configured operator name. The engine also knows their platform ids and usernames from the messaging adapter: pass
// those here to match it exactly. Nothing is written to the database and no model is called.

import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { operatorNames } from "../operator-names.js";
import type { Database } from "../graph/db.js";
import { ContextGraph } from "../graph/index.js";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import type { LoadedMessage } from "../grouping/load.js";
import { computeGrouping } from "../grouping/shadow.js";
import type { Case } from "../grouping/streams.js";
import type { ActionableItem } from "../types.js";
import { onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { clean } from "./terminal.js";

const OUT_DIR = join("eval-data", "inbox-diff");
const ASKS = new Set(["blocked_on_human", "needs_decision"]);

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
function isOperator(names: readonly string[], ...ids: Array<string | null | undefined>): boolean {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return ids.some((id) => id && lower.has(id.trim().toLowerCase()));
}

/** What the operator did to an item since an ask, that holds the ask back as it holds the item back today */
function heldByOperator(item: ItemState | undefined, askAt: string, now: string): Held | null {
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

export interface Comparison {
  both: Array<{ item: ActionableItem; caseId: string }>;
  liveOnly: Array<{ item: ActionableItem; caseId: string | null; why: string }>;
  v2Only: Array<{ entry: V2Entry; why: string }>;
  /** Cases several live items surface asks in: fewer entries, or unrelated asks behind one */
  merged: Array<{ caseId: string; items: ActionableItem[] }>;
  /** More entries than items: v2 cases surfacing an item Needs me shows once, beside the case it's lined up with */
  split: Array<{ entry: V2Entry; item: ActionableItem }>;
}

/**
 * Pure. Lines up the live items with the v2 entries: by the case each item's surfacing message landed in, else by the
 * item a surfaced case's ask was filed under. `caseOf` gives a message key's case, `keyOfEvent` an event's message
 * key, and `whyNot` and `whyNew` explain what only one side shows. Every v2 entry ends up in exactly one of both (by
 * its case), v2Only or split.
 */
export function compareInboxes(
  live: readonly ActionableItem[],
  v2: V2Inbox,
  keyOfEvent: (eventId: string) => string | undefined,
  caseOf: (key: string) => string | null,
  whyNot: (caseId: string | null, item: ActionableItem) => string,
  whyNew: (entry: V2Entry) => string,
): Comparison {
  const surfaced = new Map(v2.entries.map((e) => [e.caseId, e]));
  const out: Comparison = { both: [], liveOnly: [], v2Only: [], merged: [], split: [] };
  const byCase = new Map<string, ActionableItem[]>();
  const byItem = new Map<string, string>();
  for (const e of v2.entries) if (e.itemId && !byItem.has(e.itemId)) byItem.set(e.itemId, e.caseId);
  for (const item of live) {
    const key = keyOfEvent(item.latestEvent.id);
    const landed = key ? caseOf(key) : null;
    // Its message's case isn't surfaced (or it's a report's, in none): a case filed under the same item may be
    const caseId = landed && surfaced.has(landed) ? landed : byItem.get(item.workItem.id) ?? landed;
    if (caseId && surfaced.has(caseId)) {
      out.both.push({ item, caseId });
      const xs = byCase.get(caseId);
      if (xs) xs.push(item);
      else byCase.set(caseId, [item]);
    } else {
      out.liveOnly.push({ item, caseId, why: whyNot(caseId, item) });
    }
  }
  for (const [caseId, items] of byCase) if (items.length > 1) out.merged.push({ caseId, items });
  const liveById = new Map(live.map((i) => [i.workItem.id, i]));
  for (const e of v2.entries) {
    if (byCase.has(e.caseId)) continue;
    const item = e.itemId ? liveById.get(e.itemId) : undefined;
    if (item) out.split.push({ entry: e, item });
    else out.v2Only.push({ entry: e, why: whyNew(e) });
  }
  return out;
}

/**
 * A few words of untrusted text, safe for a terminal and inert in markdown: control characters dropped (clean), lines
 * joined, and link, image and HTML syntax escaped, so a preview neither follows nor loads anything a message holds
 */
export const excerpt = (text: string | null | undefined, n = 140) =>
  clean(text ?? "").replace(/\s+/g, " ").trim().slice(0, n).replace(/[[\]<>!`]/g, (c) => `\\${c}`);

let openSource: ReadOnlyCopy | undefined;

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["db", "operator"] as const);
  const root = projectRoot();
  const config = loadConfig();
  const handoff = config.inbox?.handoffMinConfidence ?? 0.6;
  // As the engine names the operator (operatorNames): each name and its first word. The engine adds the operator's
  // platform ids and usernames from the messaging adapter, which this reads offline only from --operator
  const given = (flags.operator ?? config.operator?.name ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const names = [...new Set(given.flatMap((n) => operatorNames(undefined, n)))];
  if (names.length === 0) console.log("No operator name (config operator.name or --operator): handoffs and the operator's own messages can't be told apart");
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    // The copy refuses writes (read-only connection, query_only), so the graph's queries run on it as they do live
    const graph = new ContextGraph({ db: source.db } as unknown as Database);
    const live = graph.getActionableItems(handoff, names);
    const g = computeGrouping(source.db);
    const messages = new Map(g.messages.map((m) => [m.key, m]));
    const caseOfKey = new Map<string, string>();
    for (const c of g.cases) for (const m of c.members) caseOfKey.set(m.key, c.id);
    const cases = new Map(g.cases.map((c) => [c.id, c]));
    const events = new Map<string, EventInfo & { key: string }>();
    for (const r of source.db.prepare(`
      SELECT e.id, e.confidence, e.work_item_id, e.message_id, t.platform, t.channel_id
      FROM events e LEFT JOIN threads t ON t.id = e.thread_id
    `).all() as Array<{ id: string; confidence: number | null; work_item_id: string | null; message_id: string; platform: string | null; channel_id: string | null }>) {
      events.set(r.id, { confidence: r.confidence ?? 0, workItemId: r.work_item_id, key: `${r.platform ?? "unknown"}:${r.channel_id ?? ""}:${r.message_id}` });
    }
    // The operator's actions in the app are events with no sender, labelled by action (core/server.ts, /api/action):
    // the ones that take an item out of Needs me. Snoozes and dismissals from the stream are on the item itself
    const acted = new Map<string, { action: string; at: string }>();
    for (const r of source.db.prepare(`
      SELECT work_item_id, reason, MAX(timestamp) AS at FROM events
      WHERE agent_id IS NULL AND work_item_id IS NOT NULL
        AND reason IN ('Operator approved', 'Operator unblocked', 'Operator dismissed', 'Operator classified as noise')
      GROUP BY work_item_id
    `).all() as Array<{ work_item_id: string; reason: string; at: string }>) acted.set(r.work_item_id, { action: r.reason, at: r.at });
    const items = new Map<string, ItemState>();
    for (const r of source.db.prepare("SELECT id, current_atc_status, snoozed_until, dismissed_at, merged_into FROM work_items").all() as Array<{
      id: string; current_atc_status: string | null; snoozed_until: string | null; dismissed_at: string | null; merged_into: string | null;
    }>) {
      items.set(r.id, {
        status: r.current_atc_status, snoozedUntil: r.snoozed_until, dismissedAt: r.dismissed_at, mergedInto: r.merged_into,
        actedOnByOperator: acted.get(r.id) ?? null,
      });
    }

    // A report's escalated lines, on the cases holding each item's live keys
    const caseOfKeyName = new Map<string, string>();
    for (const c of [...g.cases].sort((x, y) => (x.last < y.last ? -1 : 1))) for (const k of c.keys) caseOfKeyName.set(k, c.id);
    const keysOf = new Map<string, string[]>();
    for (const r of source.db.prepare("SELECT key, item_id FROM item_keys WHERE retired_at IS NULL").all() as Array<{ key: string; item_id: string }>) {
      const ks = keysOf.get(r.item_id);
      if (ks) ks.push(r.key);
      else keysOf.set(r.item_id, [r.key]);
    }
    const byEvent = new Map(g.messages.map((m) => [m.eventId, m]));
    const escalations = new Map<string, Escalation[]>();
    for (const r of source.db.prepare("SELECT event_id, work_item_id FROM event_targets").all() as Array<{ event_id: string; work_item_id: string }>) {
      const key = events.get(r.event_id)?.key;
      const message = byEvent.get(r.event_id) ?? (key ? messages.get(key) : undefined);
      if (!message) continue;
      // No case holds the item's keys (reports alone name it): an entry of its own, "item:<id>"
      const caseId = (keysOf.get(r.work_item_id) ?? []).map((k) => caseOfKeyName.get(k)).find(Boolean) ?? `item:${r.work_item_id}`;
      const xs = escalations.get(caseId);
      if (xs) xs.push({ message, itemId: r.work_item_id });
      else escalations.set(caseId, [{ message, itemId: r.work_item_id }]);
    }
    const v2 = v2Inbox(g.cases, messages, events, items, escalations, { operatorNames: names, handoff, now: new Date().toISOString() });
    const lastOf = (c: Case) => [...c.members].reverse().map((m) => messages.get(m.key)).find((m) => m && m.status !== "noise");
    const whyNot = (caseId: string | null, item: ActionableItem): string => {
      const key = events.get(item.latestEvent.id)?.key;
      if (!caseId) {
        const p = key ? g.placements.get(key) : undefined;
        return p ? `its message isn't work to v2 (${p.recognized.kind})` : "its message isn't in the v2 grouping";
      }
      const held = v2.held.get(caseId);
      if (held) return `v2 holds its case back (${held})`;
      const last = lastOf(cases.get(caseId)!);
      return last && !ASKS.has(last.status ?? "")
        ? `its case moved on: latest is ${last.status} from ${last.senderName}, ${last.at.slice(0, 16)}`
        : "its case's latest ask isn't aimed at the operator";
    };
    // The message that last set an item's status, where v2 put it: what v2 didn't count for the case
    const setBy = source.db.prepare(`
      SELECT id, status, timestamp FROM events WHERE work_item_id = ? AND status = ? ORDER BY timestamp DESC LIMIT 1
    `);
    const whyNew = (e: V2Entry): string => {
      if (!e.itemId) return "its ask was filed under no item";
      const item = items.get(e.itemId);
      if (!item) return "its item no longer exists";
      if (item.mergedInto) return `its item was merged into ${item.mergedInto}`;
      const by = item.status ? setBy.get(e.itemId, item.status) as { id: string; timestamp: string } | undefined : undefined;
      const key = by ? events.get(by.id)?.key : undefined;
      const m = key ? messages.get(key) : undefined;
      const where = !by ? "" : !m ? ", by no message v2 groups"
        : `, by ${m.senderName} at ${m.at.slice(0, 16)}, ${caseOfKey.get(m.key) === e.caseId ? "in this case" : caseOfKey.get(m.key) ? "in another case" : `which v2 sets aside (${g.placements.get(m.key)?.recognized.kind})`}`;
      return `its item is ${item.status ?? "without a status"}${where}`;
    };
    const cmp = compareInboxes(live, v2, (id) => events.get(id)?.key, (k) => caseOfKey.get(k) ?? null, whyNot, whyNew);

    console.log(`Needs me now: ${live.length} items. Under v2: ${v2.entries.length} cases (${v2.held.size} more held back by the operator or a handoff).`);
    console.log(`  both: ${cmp.both.length} · live only: ${cmp.liveOnly.length} · v2 only: ${cmp.v2Only.length} · split: ${cmp.split.length} · cases holding several live items: ${cmp.merged.length}`);
    // Every v2 entry is counted once: a case lined up with live items, one only v2 shows, or one more for an item
    const accounted = new Set(cmp.both.map((b) => b.caseId)).size + cmp.v2Only.length + cmp.split.length;
    if (accounted !== v2.entries.length) console.log(`  (counts don't add up: ${accounted} of ${v2.entries.length} v2 entries placed)`);
    const tally = (xs: Array<{ why: string }>) => {
      const t = new Map<string, number>();
      for (const x of xs) {
        // The kind of reason, without its particulars (who, when)
        const kind = x.why.replace(/:.*$/, "").replace(/, by [^,]*, /, ", ").replace(/, by .*$/, "").trim();
        t.set(kind, (t.get(kind) ?? 0) + 1);
      }
      // A reason can carry a sender's name or an item id: cleaned like any message text
      return [...t].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${excerpt(k, 120)}`).join("; ");
    };
    if (cmp.liveOnly.length) console.log(`  live only, why: ${tally(cmp.liveOnly)}`);
    if (cmp.v2Only.length) console.log(`  v2 only, why: ${tally(cmp.v2Only)}`);

    const lines: string[] = ["# Needs me: live vs v2", "", `Read ${new Date().toISOString()}. Live: ${live.length} items. v2: ${v2.entries.length} cases.`, ""];
    const itemLine = (i: ActionableItem) => `**${excerpt(i.workItem.title ?? i.workItem.id, 80)}** (${i.workItem.currentAtcStatus}, ${i.latestEvent.timestamp.slice(0, 16)}): ${excerpt(i.latestEvent.rawText)}`;
    const askLine = (e: V2Entry) => `${excerpt(e.ask.senderName, 60)}, ${e.ask.at.slice(0, 16)}: ${excerpt(e.ask.text)}`;
    lines.push(`## Live only (${cmp.liveOnly.length}): Needs me shows these, v2 wouldn't`, "");
    for (const x of cmp.liveOnly) lines.push(`- ${itemLine(x.item)}`, `  - why: ${excerpt(x.why, 200)}`);
    lines.push("", `## v2 only (${cmp.v2Only.length}): v2 would show these, Needs me doesn't`, "");
    for (const x of cmp.v2Only) lines.push(`- ${askLine(x.entry)}`, `  - why: ${excerpt(x.why, 200)}; case of ${cases.get(x.entry.caseId)?.members.length ?? 0} messages`);
    lines.push("", `## One v2 case, several live items (${cmp.merged.length}): fewer entries, or unrelated asks behind one`, "");
    for (const x of cmp.merged) {
      lines.push(`- case of ${cases.get(x.caseId)?.members.length ?? 0} messages, keys ${excerpt(cases.get(x.caseId)?.keys.join(", "), 200) || "none"}:`);
      for (const i of x.items) lines.push(`  - ${itemLine(i)}`);
    }
    lines.push("", `## One live item, several v2 cases (${cmp.split.length}): more entries`, "");
    for (const x of cmp.split) lines.push(`- ${askLine(x.entry)}`, `  - also shown by: ${itemLine(x.item)}`);
    lines.push("", `## Both (${cmp.both.length})`, "");
    for (const x of cmp.both) lines.push(`- ${itemLine(x.item)}`);
    const dir = prepareOutDir(root, OUT_DIR);
    const path = writePrivateFile(dir, "report.md", lines.join("\n") + "\n");
    console.log(`Wrote ${path}`);
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("inbox-diff.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`eval:inbox-diff: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
