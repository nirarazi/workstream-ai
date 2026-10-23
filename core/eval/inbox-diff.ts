#!/usr/bin/env node
// core/eval/inbox-diff.ts — Needs me as it is, beside Needs me as the v2 grouping would make it (read only)
//
// Usage: npm run eval:inbox-diff -- [--db workstream.db] [--operator "Dana,U0DANA"]
// Plan step 7's question (docs/work-model.md §9): would cutting over to the v2 grouping (core/grouping/) interrupt the
// operator less, or for the wrong things? From a read-only copy of the database it takes Needs me as the engine
// serves it (ContextGraph.getActionableItems) and Needs me by case under v2 (v2Inbox, core/grouping/inbox.ts), then lines them up:
//   both       an item and a case surfacing the same ask
//   live only  an item Needs me shows that v2 wouldn't, and why (its message isn't work to v2, its case moved on
//              since, or someone else has it now)
//   v2 only    a case v2 would surface that Needs me doesn't, and why (its item is done, merged, or never was one)
//   merged     several items that v2 holds in one case: fewer entries, or unrelated asks hidden behind one
//   split      an item Needs me shows once that v2 would show as several cases: more entries
// It prints counts and writes the entries, with a few words of each message, to eval-data/inbox-diff/report.md, and
// the disagreements to queue.json, for npm run eval:inbox-label to ask the operator about, blind: does this need you?
// With labels.json from that, it scores each side on the disagreements: asks shown that didn't need the operator (an
// interruption for nothing) and asks that did but weren't shown (missed).
// --operator names the operator (names or ids, comma-separated) for handoffs and their own messages; by default the
// configured operator name. The engine also knows their platform ids and usernames from the messaging adapter: pass
// those here to match it exactly. Nothing is written to the database and no model is called.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { operatorNames } from "../operator-names.js";
import type { Database } from "../graph/db.js";
import { ContextGraph } from "../graph/index.js";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { computeGrouping } from "../grouping/shadow.js";
import { ASKS, loadInboxState, v2Inbox, type V2Entry, type V2Inbox } from "../grouping/inbox.js";
import type { Case } from "../grouping/streams.js";
import type { ActionableItem } from "../types.js";
import { onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { projectFile } from "./linking-labels.js";
import { clean } from "./terminal.js";

const OUT_DIR = join("eval-data", "inbox-diff");

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

/** A disagreement to ask the operator about: an ask only one side shows, and the later message behind the other's view */
export interface QueueEntry {
  /** Stable across runs while the ask is the same: the side, the item or case, and the ask's event */
  id: string;
  /**
   * Who shows it: live (Needs me now) or v2 alone; split, v2 as one more entry for an item Needs me shows once; merged,
   * Needs me as one more entry for an ask v2 holds behind another in the same case
   */
  side: "live" | "v2" | "split" | "merged";
  /** The ask's event */
  ask: string;
  /** The later message that is why the other side doesn't show it (moved it on, closed it), if there's one */
  later: string | null;
  why: string;
}

/** The operator's answer: does this ask need them now? */
export interface InboxLabel {
  id: string;
  needed: "yes" | "no";
  labeledAt: string;
}

/** A disagreement before it's queued: what's asked, and the message that is the other side's reason, with their times */
export interface Disagreement {
  side: QueueEntry["side"];
  /** The item or case it's about */
  about: string;
  ask: { event: string; at: string };
  later: { event: string; at: string } | null;
  why: string;
}

/**
 * Pure. The queue to ask about: each disagreement with a stable id (side, item or case, ask), and its "later"
 * message: for an ask only one side shows, the message that moved it on, kept only when it is later than the ask; for
 * a split or merged entry, the ask the other side shows instead, whenever it was. In an order set by the ids' hashes,
 * so neither the order nor a count printed by side says which side shows an entry
 */
export function disagreementQueue(ds: readonly Disagreement[]): QueueEntry[] {
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  return ds
    .map((d) => ({
      id: `${d.side}:${d.about}:${d.ask.event}`,
      side: d.side,
      ask: d.ask.event,
      later: d.later && d.later.event !== d.ask.event && (d.side === "split" || d.side === "merged" || d.later.at > d.ask.at)
        ? d.later.event
        : null,
      why: d.why,
    }))
    .map((e) => ({ e, h: hash(e.id) }))
    .sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : 0))
    .map(({ e }) => e);
}

export interface SideScore {
  /** Labelled entries this side shows */
  shown: number;
  /** Shown, and the operator said it didn't need them */
  forNothing: number;
  /** Needed, and not shown */
  missed: number;
}

/**
 * Pure. Each side's mistakes on the labelled disagreements: what one side shows and the other doesn't is, by the
 * operator's answer, either an interruption for nothing on the showing side or a miss on the other. A split is v2
 * showing one more entry for an item (needed: Needs me held a separate ask behind another), merged its mirror, Needs
 * me showing one more for a case (needed: v2 held a separate ask behind another), so each side can lose on both.
 */
export function scoreDisagreements(queue: readonly QueueEntry[], labels: readonly InboxLabel[]): { live: SideScore; v2: SideScore; labelled: number } {
  // Only a yes or a no counts: anything else in a hand-edited file is no answer
  const answer = new Map(labels.filter((l) => l.needed === "yes" || l.needed === "no").map((l) => [l.id, l.needed]));
  const live: SideScore = { shown: 0, forNothing: 0, missed: 0 };
  const v2: SideScore = { shown: 0, forNothing: 0, missed: 0 };
  let labelled = 0;
  for (const q of queue) {
    const needed = answer.get(q.id);
    if (!needed) continue;
    labelled++;
    const [shows, hides] = q.side === "live" || q.side === "merged" ? [live, v2] : [v2, live];
    shows.shown++;
    if (needed === "yes") hides.missed++;
    else shows.forNothing++;
  }
  return { live, v2, labelled };
}

/**
 * A few words of untrusted text, safe for a terminal and inert in markdown: control characters dropped (clean), lines
 * joined, and link, image and HTML syntax escaped (backslashes too, so a message's own can't undo an escape), so a
 * preview neither follows nor loads anything a message holds
 */
export const excerpt = (text: string | null | undefined, n = 140) =>
  clean(text ?? "").replace(/\s+/g, " ").trim().slice(0, n).replace(/[\\[\]<>!`]/g, (c) => `\\${c}`);

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
    const { events, items, escalations } = loadInboxState(source.db, g.cases, g.messages);
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
      // A reason can carry a sender's name or an item id: cleaned for the terminal like any message text
      return [...t].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${clean(k).slice(0, 120)}`).join("; ");
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
    // The disagreements, for the operator to judge blind (npm run eval:inbox-label)
    const at = (event: string | undefined) => (event ? { event, at: events.get(event)?.at ?? "" } : null);
    const queue = disagreementQueue([
      // Shown now, not by v2: the latest message of the case v2 put it in, which moved it on
      ...cmp.liveOnly.map((x) => {
        const c = x.caseId ? cases.get(x.caseId) : undefined;
        return { side: "live" as const, about: x.item.workItem.id, ask: at(x.item.latestEvent.id)!,
          later: at(c && !v2.held.has(c.id) ? lastOf(c)?.eventId : undefined), why: x.why };
      }),
      // Shown by v2, not now: the message that last set its item's status
      ...cmp.v2Only.map((x) => {
        const item = x.entry.itemId ? items.get(x.entry.itemId) : undefined;
        const by = x.entry.itemId && item?.status ? setBy.get(x.entry.itemId, item.status) as { id: string } | undefined : undefined;
        return { side: "v2" as const, about: x.entry.caseId, ask: at(x.entry.ask.eventId)!, later: at(by?.id), why: x.why };
      }),
      // v2's second entry for an item: the ask Needs me shows it under
      ...cmp.split.map((x) => ({ side: "split" as const, about: x.entry.caseId, ask: at(x.entry.ask.eventId)!,
        later: at(x.item.latestEvent.id), why: "Needs me shows its item once, under another of its asks" })),
      // Needs me's further items in one v2 case: the ask v2 shows the case under
      ...cmp.merged.flatMap((x) => {
        const shown = v2.entries.find((e) => e.caseId === x.caseId)!;
        const extra = x.items.filter((i) => i.workItem.id !== shown.itemId && i.latestEvent.id !== shown.ask.eventId);
        const ds: Disagreement[] = extra.map((i) => ({
          side: "merged" as const, about: i.workItem.id, ask: at(i.latestEvent.id)!, later: at(shown.ask.eventId),
          why: "v2 shows its case once, under another of its asks",
        }));
        // v2's own ask is none of the items Needs me shows here: it's one only v2 shows
        if (extra.length === x.items.length) {
          ds.push({ side: "v2", about: x.caseId, ask: at(shown.ask.eventId)!, later: null, why: "v2 shows its case under an ask Needs me doesn't show" });
        }
        return ds;
      }),
    ]);
    const dir = prepareOutDir(root, OUT_DIR);
    const path = writePrivateFile(dir, "report.md", lines.join("\n") + "\n");
    writePrivateFile(dir, "queue.json", JSON.stringify({ version: 1, entries: queue }, null, 2) + "\n");
    console.log(`Wrote ${path} and ${queue.length} disagreements to judge (npm run eval:inbox-label)`);
    const labelsPath = projectFile(root, OUT_DIR, "labels.json");
    if (labelsPath) {
      const { labels } = JSON.parse(readFileSync(labelsPath, "utf8")) as { labels: InboxLabel[] };
      const sc = scoreDisagreements(queue, labels);
      console.log(`On the ${sc.labelled} of ${queue.length} disagreements judged:`);
      console.log(`  Needs me now: showed ${sc.live.shown}, ${sc.live.forNothing} of them for nothing; missed ${sc.live.missed}`);
      console.log(`  v2:           showed ${sc.v2.shown}, ${sc.v2.forNothing} of them for nothing; missed ${sc.v2.missed}`);
    }
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
