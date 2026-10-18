// core/eval/linking-data.ts — Messages and groupings for the linking eval, read from workstream.db and eval-data/relink
//
// The unit labeled and scored is a message, keyed by its platform identity (messageKey), not by events.id: an event
// row is a random UUID per (message, thread), so it changes when messages are re-ingested or relinked, and one message
// can have several rows (stored once under each thread id it was seen in). Those rows collapse into one message, and
// one of them represents it for everything: its thread, text and item (see representativeRows).
//
// The database is never opened in place: callers use openReadOnly, the re-link dry run's private read-only copy.
// Groupings map a message key to a work item id. They measure membership, not what the inbox shows, so a dismissed
// item still counts as an item:
//   current — each event's work item (else its thread's), following merged_into to the item it was merged into;
//   relink  — the items the re-link dry run proposed (eval-data/relink/items.json; npm run relink writes it), whose
//             event ids are mapped to message keys through the database.

import type BetterSqlite3 from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectRoot } from "../config.js";
import { ownLines } from "../graph/own-lines.js";
import { hasColumn, RELINK_OUT_DIR } from "../graph/relink.js";
import { projectFile } from "./linking-labels.js";
import type { Grouping } from "./linking-metrics.js";

export const GROUPINGS = ["current", "relink"] as const;
export type GroupingName = (typeof GROUPINGS)[number];

/**
 * A message's platform identity: "<platform>:<channel id>:<message id>", e.g. "slack:C0OPS:1767603600.000100".
 * events.message_id is the platform's id for the message (Slack's ts, unique within a channel; an MCP push's UUID),
 * so with the platform and channel it's stable across re-ingests and regroupings. Platform and channel ids hold no
 * colon; the message id is everything after the second one. This is the observation dedupeKey to come.
 */
export function messageKey(platform: string | null, channelId: string | null, messageId: string): string {
  return `${platform ?? "unknown"}:${channelId ?? ""}:${messageId}`;
}

/** One message, as the labeler shows it and the sampler reads its signals */
export interface Observation {
  /** messageKey(): what labels are keyed by */
  id: string;
  /** events.id of the row that represents the message */
  eventId: string;
  threadId: string;
  senderId: string | null;
  senderName: string;
  channelId: string | null;
  channelName: string;
  timestamp: string;
  /** The lines the sender wrote themselves (no quoted or forwarded lines) */
  text: string;
}

export interface MessageIndex {
  /** One per message with text of its own */
  observations: Observation[];
  /** events.id → message key, for every event */
  keyOfEvent: Map<string, string>;
  /** Message key → events.id of the row that represents it, for every message */
  rowOfMessage: Map<string, string>;
}

/** The project the command runs in (its eval-data/, where npm run relink writes too), else this checkout's: as relink-cli */
export function projectRoot(): string {
  return existsSync(resolve("config", "default.yaml")) ? process.cwd() : findProjectRoot();
}

interface Row {
  id: string; thread_id: string; message_id: string; agent_id: string | null; sender_name: string;
  platform: string | null; channel_id: string | null; channel_name: string; timestamp: string; raw_text: string | null;
}

/**
 * The row that represents each message among its rows (in stored order): the one in the message's own thread. A
 * thread is keyed by its first message's id (Slack's thread_ts), so a row whose thread id is another message's is a
 * reply in that thread, and wins over a row filed under the message's own id (as a message of the channel's history
 * when it was first seen on its own). Otherwise the first stored row.
 */
function representativeRows(rows: Row[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const key = messageKey(r.platform, r.channel_id, r.message_id);
    const held = out.get(key);
    if (!held || (held.thread_id === held.message_id && r.thread_id !== r.message_id)) out.set(key, r);
  }
  return out;
}

/** Every event's message key, each message's representative row, and an observation per message with text */
export function loadMessageIndex(db: BetterSqlite3.Database): MessageIndex {
  const rows = db.prepare(`
    SELECT e.id, e.thread_id, e.message_id, e.agent_id, COALESCE(a.name, 'unknown') AS sender_name, t.platform,
           t.channel_id, COALESCE(t.channel_name, '') AS channel_name, e.timestamp, e.raw_text
    FROM events e
    LEFT JOIN agents a ON a.id = e.agent_id
    LEFT JOIN threads t ON t.id = e.thread_id
    ORDER BY e.rowid
  `).all() as Row[];
  const keyOfEvent = new Map(rows.map((r) => [r.id, messageKey(r.platform, r.channel_id, r.message_id)]));
  const rowOfMessage = new Map<string, string>();
  const observations: Observation[] = [];
  for (const [key, r] of representativeRows(rows)) {
    rowOfMessage.set(key, r.id);
    const text = ownLines(r.raw_text ?? "").trim();
    if (!text) continue;
    observations.push({
      id: key,
      eventId: r.id,
      threadId: r.thread_id,
      senderId: r.agent_id,
      senderName: r.sender_name,
      channelId: r.channel_id,
      channelName: r.channel_name,
      timestamp: r.timestamp,
      text,
    });
  }
  observations.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { observations, keyOfEvent, rowOfMessage };
}

/**
 * An event-level grouping (events.id → item) as a message-level one: each message takes its representative row's
 * item, or none. `unmatched` counts events the database doesn't hold (a proposal made from an older copy).
 */
export function byMessage(byEvent: Grouping, index: Pick<MessageIndex, "keyOfEvent" | "rowOfMessage">): { grouping: Grouping; unmatched: number } {
  const grouping = new Map<string, string>();
  for (const [key, row] of index.rowOfMessage) {
    const item = byEvent.get(row);
    if (item !== undefined) grouping.set(key, item);
  }
  let unmatched = 0;
  for (const eventId of byEvent.keys()) if (!index.keyOfEvent.has(eventId)) unmatched++;
  return { grouping, unmatched };
}

/** Names of the people and agents in the fleet: addressees, not subjects, so not a grouping signal */
export function loadSenderNames(db: BetterSqlite3.Database): string[] {
  return (db.prepare("SELECT DISTINCT name FROM agents").all() as Array<{ name: string }>).map((r) => r.name);
}

/**
 * Where each item ends up after following merged_into: the end of its chain, or, for an item in a merge cycle (or
 * leading into one), the cycle's smallest id, so every member of a cycle resolves to the same item.
 */
export function mergeTargets(mergedInto: ReadonlyMap<string, string>): (id: string) => string {
  const memo = new Map<string, string>();
  return (id) => {
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let current = id;
    let target: string | undefined;
    while (target === undefined) {
      const known = memo.get(current);
      if (known !== undefined) {
        target = known;
      } else if (onPath.has(current)) {
        const cycle = path.slice(onPath.get(current)!);
        target = cycle.reduce((a, b) => (b < a ? b : a));
      } else {
        onPath.set(current, path.length);
        path.push(current);
        const next = mergedInto.get(current);
        if (next === undefined) target = current;
        else current = next;
      }
    }
    for (const p of path) memo.set(p, target);
    return target;
  };
}

/** The live grouping by event: each event's work item, else its thread's, with merges followed; dismissed items count */
export function currentEventGrouping(db: BetterSqlite3.Database): Grouping {
  const mergedInto = new Map<string, string>();
  if (hasColumn(db, "work_items", "merged_into")) {
    const rows = db.prepare("SELECT id, merged_into FROM work_items WHERE merged_into IS NOT NULL").all() as Array<{ id: string; merged_into: string }>;
    for (const r of rows) mergedInto.set(r.id, r.merged_into);
  }
  const target = mergeTargets(mergedInto);
  const rows = db.prepare(`
    SELECT e.id, COALESCE(e.work_item_id, t.work_item_id) AS item
    FROM events e LEFT JOIN threads t ON t.id = e.thread_id
  `).all() as Array<{ id: string; item: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) if (r.item) out.set(r.id, target(r.item));
  return out;
}

export function relinkItemsPath(root: string): string {
  return resolve(root, RELINK_OUT_DIR, "items.json");
}

/** Parses the re-link dry run's items.json into an event-level grouping: { proposed: [{ id, events: [events.id, …] }, …] } */
export function parseRelinkItems(content: string): Grouping {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Re-link items: the file isn't valid JSON");
  }
  const proposed = (raw as { proposed?: unknown } | null)?.proposed;
  if (!Array.isArray(proposed)) throw new Error("Re-link items: expected a proposed list");
  const out = new Map<string, string>();
  proposed.forEach((item: { id?: unknown; events?: unknown }, i) => {
    if (typeof item?.id !== "string" || !Array.isArray(item.events) || !item.events.every((e) => typeof e === "string")) {
      throw new Error(`Re-link items: proposed item ${i + 1} is malformed`);
    }
    for (const e of item.events as string[]) out.set(e, item.id);
  });
  return out;
}

/** The re-link proposal's event-level grouping, or null when there's no dry run output yet */
export function loadRelinkGrouping(root: string): Grouping | null {
  const path = projectFile(root, RELINK_OUT_DIR, "items.json");
  return path ? parseRelinkItems(readFileSync(path, "utf-8")) : null;
}

/** A full gold clustering of message keys: { "clusters": [[key, …], …] } or just the list. A message in two clusters is an error. */
export function parseGoldClusters(content: string): Grouping {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Gold clustering: the file isn't valid JSON");
  }
  const list = Array.isArray(raw) ? raw : (raw as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(list)) throw new Error("Gold clustering: expected a list of clusters (lists of message keys)");
  const out = new Map<string, string>();
  list.forEach((cluster: unknown, i) => {
    if (!Array.isArray(cluster) || !cluster.every((id) => typeof id === "string")) throw new Error(`Gold clustering: cluster ${i + 1} isn't a list of message keys`);
    for (const id of cluster as string[]) {
      if (out.has(id)) throw new Error(`Gold clustering: a message is in clusters ${Number(out.get(id)) + 1} and ${i + 1}`);
      out.set(id, String(i));
    }
  });
  return out;
}

export interface LoadedGroupings {
  /** Message key → item, per grouping */
  groupings: Map<GroupingName, Grouping>;
  /** Per grouping, events it places that the database doesn't hold (they can't be scored) */
  unmatched: Map<GroupingName, number>;
}

/** Loads the named groupings, by message key. Fails with a hint when the re-link output is missing. */
export function loadGroupings(names: GroupingName[], root: string, db: BetterSqlite3.Database, index: MessageIndex): LoadedGroupings {
  const out: LoadedGroupings = { groupings: new Map(), unmatched: new Map() };
  for (const name of names) {
    let byEvent: Grouping;
    if (name === "current") {
      byEvent = currentEventGrouping(db);
    } else {
      const g = loadRelinkGrouping(root);
      if (!g) throw new Error(`No re-link output at ${relinkItemsPath(root)}. Run: npm run relink`);
      byEvent = g;
    }
    const { grouping, unmatched } = byMessage(byEvent, index);
    out.groupings.set(name, grouping);
    out.unmatched.set(name, unmatched);
  }
  return out;
}

/** --grouping current,relink → the names, each once. An unknown name is an error. */
export function parseGroupingNames(value: string): GroupingName[] {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!(GROUPINGS as readonly string[]).includes(n)) throw new Error(`Unknown grouping ${JSON.stringify(n)} (groupings: ${GROUPINGS.join(", ")})`);
  }
  if (!names.length) throw new Error("--grouping needs at least one grouping");
  return [...new Set(names)] as GroupingName[];
}

/** Strict options: --name value pairs from `allowed`. Anything else, or a missing value, is an error. */
export function parseFlags<T extends string>(argv: string[], allowed: readonly T[]): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag.startsWith("--") ? flag.slice(2) : null;
    if (!name || !(allowed as readonly string[]).includes(name)) {
      throw new Error(`Unexpected argument ${JSON.stringify(flag)} (options: --${allowed.join(", --")})`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new Error(`--${name} needs a value`);
    out[name as T] = value;
    i++;
  }
  return out;
}

/** Exit codes for a run stopped by a signal, by convention 128 + the signal's number */
export const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Runs `stop` (save, restore the terminal, close the copy) on SIGHUP, SIGINT or SIGTERM, then exits 128 + signal */
export function onStopSignals(stop: () => void): void {
  for (const name of Object.keys(SIGNAL_EXIT)) {
    process.on(name, () => {
      try {
        stop();
      } finally {
        process.exit(SIGNAL_EXIT[name]);
      }
    });
  }
}
