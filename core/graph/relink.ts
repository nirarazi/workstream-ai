// core/graph/relink.ts — Re-link dry run: replays every stored event through the resolver, read-only
//
// It copies the database to a private temporary directory and opens the copy read-only (refusing to run otherwise),
// loads what it needs into memory, replays the events in time order through the resolver with no model, and writes its
// reports under eval-data/relink/ (gitignored). The reports hold ids and keys, the titles of current work items and
// agents' lane tags for review, but no raw message text.
//
// Where the resolver would ask the model (rule 5), the replay keeps the item the event was linked to when that item
// still resolves to a proposed one, and otherwise applies the resolver's fallback and counts the event as needing the
// model.

import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../config.js";
import type { StatusCategory } from "../types.js";
import { DefaultExtractor, knownTicketPrefixes, looksLikeTicketKey } from "./extractors/default.js";
import {
  itemKey,
  keyKind,
  resolve,
  type ItemKey,
  type KeyKind,
  type MessageKind,
  type Resolution,
  type ResolverGraph,
  type ResolverOptions,
  type ReportSignal,
  type SenderKind,
  type SubjectRule,
} from "./resolver.js";

const DEFAULT_TICKET_PATTERN = "\\b([A-Z]{2,6}-\\d+)\\b";
/** Where the reports go, relative to the project root */
export const RELINK_OUT_DIR = join("eval-data", "relink");

// --- Reading the database -----------------------------------------------------------------------------------------

/** A read-only connection to a private copy of a database; close() closes it and deletes the copy */
export interface ReadOnlyCopy {
  db: BetterSqlite3.Database;
  /** False when the source still changed while its last copy was taken (the copy passed its check regardless) */
  stable: boolean;
  close(): void;
}

const TEMP_PREFIX = "workstream-relink-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes copies earlier runs left behind (killed before they could clean up): this user's workstream-relink-<pid>-*
 * directories in `dir` whose process is gone. Returns how many it removed.
 */
export function sweepStaleCopies(dir: string = tmpdir()): number {
  let removed = 0;
  const uid = process.getuid?.();
  for (const name of readdirSync(dir)) {
    const m = new RegExp(`^${TEMP_PREFIX}(\\d+)-`).exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) continue;
      if (alive(Number(m[1]))) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove
    }
  }
  return removed;
}

interface SourceState {
  db: string;
  wal: string | null;
}

function sourceState(dbPath: string): SourceState {
  const of = (p: string) => {
    const st = statSync(p);
    return `${st.size}:${st.mtimeMs}`;
  };
  return { db: of(dbPath), wal: existsSync(`${dbPath}-wal`) ? of(`${dbPath}-wal`) : null };
}

/** For tests: a hook between copying and opening, which may change the source */
export interface OpenReadOnlyHooks {
  afterCopy?(attempt: number): void;
}

const COPY_ATTEMPTS = 2;

/**
 * Opens a database strictly read-only, and never in place: the file (and its write-ahead log, if there is one) is
 * copied into a fresh private temporary directory, and the copy is opened with SQLite's read-only flag. Nothing is
 * created or changed beside the original, whether or not the engine has it open. A handle that could write is refused.
 * The copy is checked (PRAGMA quick_check) and taken again once if it fails, or if the source changed while it was
 * copied. It's removed at exit if still open; copies older runs left are swept first.
 */
export function openReadOnly(dbPath: string, hooks: OpenReadOnlyHooks = {}): ReadOnlyCopy {
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  sweepStaleCopies();
  const dir = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  chmodSync(dir, 0o700);
  const remove = () => rmSync(dir, { recursive: true, force: true });
  // The backstop if the process exits with the copy still open (the CLI handles SIGINT and SIGTERM for the whole run)
  process.on("exit", remove);
  const detach = () => process.removeListener("exit", remove);
  const cleanUp = () => {
    try {
      remove();
    } finally {
      detach();
    }
  };

  const copy = join(dir, "workstream.db");
  try {
    for (let attempt = 1; ; attempt++) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true });
      const before = sourceState(dbPath);
      // The log first: if the engine checkpoints between the two copies, the file already holds what the log says
      if (before.wal !== null) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
      copyFileSync(dbPath, copy);
      hooks.afterCopy?.(attempt);
      const after = sourceState(dbPath);
      const changed = before.db !== after.db || before.wal !== after.wal;

      const db = new BetterSqlite3(copy, { readonly: true, fileMustExist: true });
      if (!db.readonly) {
        db.close();
        throw new Error("Refusing to run: the database didn't open read-only");
      }
      // Belt and braces: SQLite itself refuses any write on this connection
      db.pragma("query_only = ON");
      let healthy: boolean;
      try {
        healthy = db.pragma("quick_check", { simple: true }) === "ok";
      } catch {
        healthy = false;
      }
      if ((changed || !healthy) && attempt < COPY_ATTEMPTS) {
        db.close();
        continue;
      }
      if (!healthy) {
        db.close();
        throw new Error("Refusing to run: the copy of the database failed its integrity check");
      }
      return {
        db,
        stable: !changed,
        close: () => {
          try {
            db.close();
          } finally {
            cleanUp();
          }
        },
      };
    }
  } catch (err) {
    cleanUp();
    throw err;
  }
}

export interface SnapshotEvent {
  id: string;
  threadId: string;
  messageId: string;
  workItemId: string | null;
  agentId: string | null;
  channelId: string | null;
  platform: string | null;
  status: StatusCategory;
  text: string;
  timestamp: string;
  digest: boolean;
  senderKind: SenderKind;
}

export interface SnapshotItem {
  id: string;
  source: string;
  title: string;
  mergedInto: string | null;
  dismissed: boolean;
}

export interface Snapshot {
  events: SnapshotEvent[];
  items: SnapshotItem[];
  threads: Array<{ id: string; workItemId: string | null }>;
  junction: Array<{ threadId: string; workItemId: string; relation: string }>;
  /** Ticket prefixes the tracker has confirmed (work items it enriched), e.g. ["OPS-"] */
  trackerPrefixes: string[];
}

function hasColumn(db: BetterSqlite3.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === column);
}

function hasTable(db: BetterSqlite3.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function senderKind(isBot: number | null, botType: string | null): SenderKind {
  if (botType === "notification") return "notification";
  if (isBot === 1) return "agent";
  if (isBot === 0) return "human";
  return "unknown";
}

/** Copies the events, items, threads and links the replay needs into memory */
export function loadSnapshot(db: BetterSqlite3.Database): Snapshot {
  const digestCol = hasColumn(db, "events", "digest") ? "e.digest" : "0";
  const botCols = hasColumn(db, "agents", "is_bot") ? "a.is_bot, a.bot_type" : "NULL AS is_bot, NULL AS bot_type";
  const rows = db.prepare(`
    SELECT e.id, e.thread_id, e.message_id, e.work_item_id, e.agent_id, e.status, e.raw_text, e.timestamp,
           ${digestCol} AS digest, t.channel_id, t.platform, ${botCols}
    FROM events e
    LEFT JOIN threads t ON t.id = e.thread_id
    LEFT JOIN agents a ON a.id = e.agent_id
    ORDER BY e.timestamp, e.created_at, e.rowid
  `).all() as Array<{
    id: string; thread_id: string; message_id: string; work_item_id: string | null; agent_id: string | null;
    status: StatusCategory; raw_text: string; timestamp: string; digest: number; channel_id: string | null;
    platform: string | null; is_bot: number | null; bot_type: string | null;
  }>;
  const itemCols = ["merged_into", "dismissed_at"].map((c) => (hasColumn(db, "work_items", c) ? c : `NULL AS ${c}`)).join(", ");
  const items = db.prepare(`SELECT id, source, title, ${itemCols} FROM work_items`).all() as Array<{
    id: string; source: string; title: string; merged_into: string | null; dismissed_at: string | null;
  }>;
  const threads = db.prepare("SELECT id, work_item_id FROM threads").all() as Array<{ id: string; work_item_id: string | null }>;
  const junction = hasTable(db, "thread_work_items")
    ? (db.prepare("SELECT thread_id, work_item_id, relation FROM thread_work_items").all() as Array<{ thread_id: string; work_item_id: string; relation: string }>)
    : [];
  const enriched = hasTable(db, "enrichments")
    ? (db.prepare("SELECT DISTINCT work_item_id FROM enrichments").all() as Array<{ work_item_id: string }>)
    : [];
  const trackerPrefixes = [...new Set(enriched.map((r) => r.work_item_id).filter(looksLikeTicketKey).map((id) => id.slice(0, id.lastIndexOf("-") + 1).toUpperCase()))];

  return {
    events: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      messageId: r.message_id,
      workItemId: r.work_item_id,
      agentId: r.agent_id,
      channelId: r.channel_id,
      platform: r.platform,
      status: r.status,
      text: r.raw_text ?? "",
      timestamp: r.timestamp,
      digest: r.digest === 1,
      senderKind: senderKind(r.is_bot, r.bot_type),
    })),
    items: items.map((r) => ({ id: r.id, source: r.source, title: r.title, mergedInto: r.merged_into, dismissed: r.dismissed_at !== null })),
    threads: threads.map((r) => ({ id: r.id, workItemId: r.work_item_id })),
    junction: junction.map((r) => ({ threadId: r.thread_id, workItemId: r.work_item_id, relation: r.relation })),
    trackerPrefixes,
  };
}

// --- The replay ---------------------------------------------------------------------------------------------------

/** How an event was placed: a resolver rule, "promoted" (rule 2 with promotion), or "stored" (the link it already had) */
export type Placement = "mcp" | "thread" | "promoted" | "ref" | "reply" | "stored" | "new" | "absorbed";
export type Unplaced = "report" | "notification" | "activity" | "noise";

export interface ProposedItem {
  id: string;
  keys: ItemKey[];
  events: string[];
  threads: string[];
  /** Current work items whose events or threads this one takes in, with how many of its events each held */
  formerItems: Array<{ id: string; events: number }>;
  /** Proposed items folded into this one (by promotion) */
  mergedFrom: string[];
  createdBy: Placement;
}

export interface Decision {
  event: string;
  thread: string;
  kind: MessageKind;
  /** Where it was placed, or why it wasn't */
  outcome: Placement | Unplaced;
  item: string | null;
  /** Rules 1–4 didn't decide and its current link didn't resolve either: the model would have been asked */
  needsModel: boolean;
  /** It names several tickets or PRs, none as its subject */
  ambiguous: boolean;
  /** The status the event was classified with */
  status: StatusCategory;
  /** Which report heuristic fired, for a report (null otherwise) */
  report: ReportSignal | null;
  mentions: number;
}

export interface Merge {
  from: string;
  into: string;
  event: string;
}

export interface ReplayResult {
  items: ProposedItem[];
  decisions: Decision[];
  merges: Merge[];
  /** Ticket key → the items whose (non-report) messages mention it, besides its holder */
  mentionedIn: Map<ItemKey, Set<string>>;
}

interface WorkingItem {
  id: string;
  keys: Set<ItemKey>;
  events: string[];
  threads: Set<string>;
  former: Map<string, number>;
  mergedFrom: string[];
  createdBy: Placement;
}

/** Replays the snapshot's events in order through the resolver. Pure: reads the snapshot, returns a proposal. */
export function replay(snapshot: Snapshot, options: ResolverOptions): ReplayResult {
  const items = new Map<string, WorkingItem>();
  const byKey = new Map<ItemKey, string>();
  const byMessage = new Map<string, string>();
  const eventItem = new Map<string, string>();
  /** Events of threads no item holds yet, which join the item that later takes the thread */
  const pending = new Map<string, SnapshotEvent[]>();
  /** Earlier work events per thread (not reports, not noise) */
  const workInThread = new Map<string, number>();
  /** Threads a report started (its first event, not noise): no reply claims them */
  const reportThreads = new Set<string>();
  /** In a report's thread, the key of the latest request made in it, which later replies continue */
  const latestRequest = new Map<string, ItemKey>();
  const seenThreads = new Set<string>();
  const decisions: Decision[] = [];
  const decisionOf = new Map<string, Decision>();
  const merges: Merge[] = [];
  const mentionsOf = new Map<string, ItemKey[]>();
  const threadItemOf = new Map<string, string | null>(snapshot.threads.map((t) => [t.id, t.workItemId]));
  let nextId = 1;

  const graph: ResolverGraph = {
    itemForKey: (key) => byKey.get(key) ?? null,
    keysOf: (id) => [...(items.get(id)?.keys ?? [])],
    itemForMessage: (ref) => byMessage.get(ref) ?? null,
  };

  function addEvent(item: WorkingItem, event: SnapshotEvent): void {
    item.events.push(event.id);
    item.threads.add(event.threadId);
    eventItem.set(event.id, item.id);
    byMessage.set(`${event.threadId}/${event.messageId}`, item.id);
    const former = event.workItemId ?? threadItemOf.get(event.threadId) ?? null;
    if (former) item.former.set(former, (item.former.get(former) ?? 0) + 1);
  }

  function addKey(item: WorkingItem, key: ItemKey): void {
    const holder = byKey.get(key);
    if (holder && holder !== item.id) return; // the resolver never asks for this; a key has one holder
    item.keys.add(key);
    byKey.set(key, item.id);
    if (keyKind(key) === "thread") {
      // The thread's earlier events that belonged to no item belong to this one now
      const threadId = key.slice("thread:".length);
      for (const event of pending.get(threadId) ?? []) {
        addEvent(item, event);
        const d = decisionOf.get(event.id);
        if (d) {
          d.item = item.id;
          d.outcome = "absorbed";
        }
      }
      pending.delete(threadId);
    }
  }

  function create(keys: ItemKey[], createdBy: Placement): WorkingItem {
    const item: WorkingItem = { id: `r${nextId++}`, keys: new Set(), events: [], threads: new Set(), former: new Map(), mergedFrom: [], createdBy };
    items.set(item.id, item);
    for (const k of keys) addKey(item, k);
    return item;
  }

  function merge(fromId: string, into: WorkingItem, event: SnapshotEvent): void {
    const from = items.get(fromId);
    if (!from || from === into) return;
    items.delete(fromId);
    for (const k of from.keys) {
      byKey.set(k, into.id);
      into.keys.add(k);
    }
    for (const e of from.events) eventItem.set(e, into.id);
    into.events.push(...from.events);
    for (const t of from.threads) into.threads.add(t);
    for (const [id, n] of from.former) into.former.set(id, (into.former.get(id) ?? 0) + n);
    into.mergedFrom.push(fromId, ...from.mergedFrom);
    for (const [ref, id] of byMessage) if (id === fromId) byMessage.set(ref, into.id);
    merges.push({ from: fromId, into: into.id, event: event.id });
  }

  /** The proposed item the event's current link stands for, if the replay has one */
  function storedItem(event: SnapshotEvent): string | null {
    const id = event.workItemId;
    if (!id) return null;
    const candidates: ItemKey[] = id.startsWith("thread:")
      ? [itemKey("thread", id.slice("thread:".length))]
      : [itemKey("ticket", id), itemKey("mcp", id)];
    for (const k of candidates) {
      const held = byKey.get(k);
      if (held) return held;
    }
    return null;
  }

  function apply(event: SnapshotEvent, resolution: Resolution, needsModel: boolean, ambiguous: boolean): Decision {
    const threadKey = itemKey("thread", event.threadId);
    const decision: Decision = {
      event: event.id,
      thread: event.threadId,
      kind: resolution.kind,
      outcome: "new",
      item: null,
      needsModel,
      ambiguous,
      status: event.status,
      report: resolution.report,
      mentions: resolution.mentions.length,
    };
    switch (resolution.action) {
      case "join": {
        const item = items.get(resolution.itemId)!;
        for (const m of resolution.merge) merge(m, item, event);
        for (const k of resolution.addKeys) addKey(item, k);
        addEvent(item, event);
        decision.outcome = resolution.promoted ? "promoted" : resolution.rule;
        decision.item = item.id;
        break;
      }
      case "create": {
        const item = create(resolution.keys, resolution.rule);
        const request = resolution.keys.find((k) => keyKind(k) === "message");
        if (request) latestRequest.set(event.threadId, request);
        addEvent(item, event);
        decision.outcome = resolution.rule;
        decision.item = item.id;
        break;
      }
      case "none": {
        decision.outcome = resolution.reason;
        if (!byKey.has(threadKey)) {
          const list = pending.get(event.threadId);
          if (list) list.push(event);
          else pending.set(event.threadId, [event]);
        }
        break;
      }
      case "undecided": {
        // Rule 5 stand-in: keep the event's current link where it still resolves
        const kept = storedItem(event);
        if (kept) {
          const item = items.get(kept)!;
          if (!byKey.has(threadKey) && !reportThreads.has(event.threadId)) addKey(item, threadKey);
          addEvent(item, event);
          decision.outcome = "stored";
          decision.ambiguous = resolution.ambiguous;
          decision.item = item.id;
          break;
        }
        return apply(event, resolution.fallback, true, resolution.ambiguous);
      }
    }
    return decision;
  }

  for (const event of snapshot.events) {
    const resolution = resolve(
      {
        threadId: event.threadId,
        messageRef: `${event.threadId}/${event.messageId}`,
        senderId: event.agentId,
        channelId: event.channelId,
        senderKind: event.senderKind,
        text: event.text,
        status: event.status,
        mcpWorkItemId: event.platform === "mcp" ? event.workItemId : null,
        priorInThread: workInThread.get(event.threadId) ?? 0,
        inReportThread: reportThreads.has(event.threadId),
        reportThreadItem: latestRequest.has(event.threadId) ? byKey.get(latestRequest.get(event.threadId)!) ?? null : null,
        digest: event.digest,
      },
      graph,
      options,
    );
    const decision = apply(event, resolution, false, false);
    const opensThread = !seenThreads.has(event.threadId);
    seenThreads.add(event.threadId);
    if (opensThread && resolution.kind === "report" && event.status !== "noise") reportThreads.add(event.threadId);
    if (resolution.kind !== "report" && event.status !== "noise") {
      workInThread.set(event.threadId, (workInThread.get(event.threadId) ?? 0) + 1);
    }
    decisions.push(decision);
    decisionOf.set(event.id, decision);
    if (resolution.kind !== "report") mentionsOf.set(event.id, resolution.mentions);
  }

  const mentionedIn = new Map<ItemKey, Set<string>>();
  for (const [eventId, mentions] of mentionsOf) {
    const item = eventItem.get(eventId);
    if (!item) continue;
    for (const k of mentions) {
      if (byKey.get(k) === item) continue;
      const set = mentionedIn.get(k) ?? new Set<string>();
      set.add(item);
      mentionedIn.set(k, set);
    }
  }

  return {
    items: [...items.values()].map((i) => ({
      id: i.id,
      keys: [...i.keys],
      events: i.events,
      threads: [...i.threads],
      formerItems: [...i.former].map(([id, events]) => ({ id, events })).sort((a, b) => b.events - a.events),
      mergedFrom: i.mergedFrom,
      createdBy: i.createdBy,
    })),
    decisions,
    merges,
    mentionedIn,
  };
}

// --- Metrics ------------------------------------------------------------------------------------------------------

function formerKind(item: SnapshotItem): string {
  if (item.id.startsWith("thread:")) return "thread";
  if (item.source === "mcp") return "mcp";
  return looksLikeTicketKey(item.id) ? "ticket" : "other";
}

function primaryKind(keys: ItemKey[]): KeyKind {
  for (const kind of ["ticket", "pr", "subject", "mcp", "thread"] as KeyKind[]) {
    if (keys.some((k) => keyKind(k) === kind)) return kind;
  }
  return "thread";
}

function count<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function spread(sizes: number[]): { tickets: number; mean: number; max: number; moreThanOne: number } {
  const n = sizes.length;
  return {
    tickets: n,
    mean: n ? Math.round((sizes.reduce((a, b) => a + b, 0) / n) * 100) / 100 : 0,
    max: n ? Math.max(...sizes) : 0,
    moreThanOne: sizes.filter((s) => s > 1).length,
  };
}

/** Each report heuristic's reports, by the status they were classified with */
function bySignalStatus(decisions: Decision[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const d of decisions) {
    if (d.kind !== "report" || !d.report) continue;
    const row = (out[d.report] ??= {});
    row[d.status] = (row[d.status] ?? 0) + 1;
  }
  return out;
}

export interface RelinkSummary {
  events: number;
  before: {
    items: number;
    openItems: number;
    byKind: Record<string, number>;
    singleMessageItems: number;
    zeroEventItems: number;
  };
  after: {
    items: number;
    byKind: Record<string, number>;
    singleMessageItems: number;
  };
  /** How each event was placed, or why it wasn't */
  outcomes: Record<string, number>;
  /** Events where rules 1–4 didn't decide and the current link didn't resolve either (the model would be asked) */
  needsModel: number;
  /** Undecided events naming several tickets or PRs with none as their subject (whether or not their link resolved) */
  ambiguous: number;
  reports: { messages: number; alreadyFlaggedDigest: number; newlyDetected: number; bySignal: Record<string, number>; bySignalStatus: Record<string, Record<string, number>>; asks: number };
  notifications: number;
  /** Events left as activity on no item (lone notes with nothing to attach to) */
  activityNotItem: number;
  merges: number;
  promotions: number;
  /** Items per ticket key: before, the items whose timelines touch it; after, its holder plus items whose own
   *  (non-report) messages mention it, and the holders alone (one each by construction) */
  itemsPerTicket: {
    before: ReturnType<typeof spread>;
    after: ReturnType<typeof spread>;
    holdersAfter: ReturnType<typeof spread>;
  };
  formerItems: { carried: number; notCarried: number };
  notes: string[];
}

/** What the replay can't show, said alongside its numbers */
export const RELINK_NOTES = [
  "Rule 4 (reply, quote or forward metadata) never fires in the replay: the database stores no such metadata.",
  "Rule 5 (the model) isn't run: an event keeps its current link where that still resolves, and otherwise counts in needsModel.",
];

export function summarize(snapshot: Snapshot, result: ReplayResult): RelinkSummary {
  const live = snapshot.items.filter((i) => !i.mergedInto);
  const eventsPerFormer = new Map<string, number>();
  for (const e of snapshot.events) if (e.workItemId) eventsPerFormer.set(e.workItemId, (eventsPerFormer.get(e.workItemId) ?? 0) + 1);

  // Before: the items whose timeline touches each ticket (its own, and every item whose thread names it)
  const threadItem = new Map(snapshot.threads.map((t) => [t.id, t.workItemId]));
  const liveIds = new Set(live.map((i) => i.id));
  const touchingBefore = new Map<string, Set<string>>();
  for (const id of liveIds) if (looksLikeTicketKey(id)) touchingBefore.set(id, new Set([id]));
  for (const j of snapshot.junction) {
    if (!looksLikeTicketKey(j.workItemId)) continue;
    const set = touchingBefore.get(j.workItemId) ?? new Set<string>();
    const owner = threadItem.get(j.threadId);
    if (owner && liveIds.has(owner)) set.add(owner);
    if (liveIds.has(j.workItemId)) set.add(j.workItemId);
    if (set.size) touchingBefore.set(j.workItemId, set);
  }

  const holders = new Map<string, string>();
  for (const item of result.items) for (const k of item.keys) if (keyKind(k) === "ticket") holders.set(k, item.id);
  const touchingAfter = new Map<string, Set<string>>();
  for (const [k, id] of holders) touchingAfter.set(k, new Set([id]));
  for (const [k, set] of result.mentionedIn) {
    if (keyKind(k) !== "ticket") continue;
    const all = touchingAfter.get(k) ?? new Set<string>();
    for (const id of set) all.add(id);
    touchingAfter.set(k, all);
  }
  const holderCounts = new Map<string, number>();
  for (const item of result.items) for (const k of item.keys) if (keyKind(k) === "ticket") holderCounts.set(k, (holderCounts.get(k) ?? 0) + 1);

  const outcomes = count(result.decisions.map((d) => d.outcome));
  const reportEvents = result.decisions.filter((d) => d.kind === "report").map((d) => d.event);
  const digestFlagged = new Set(snapshot.events.filter((e) => e.digest).map((e) => e.id));
  const carried = new Set(result.items.flatMap((i) => i.formerItems.map((f) => f.id)));

  return {
    events: snapshot.events.length,
    before: {
      items: live.length,
      openItems: live.filter((i) => !i.dismissed).length,
      byKind: count(live.map(formerKind)),
      singleMessageItems: live.filter((i) => eventsPerFormer.get(i.id) === 1).length,
      zeroEventItems: live.filter((i) => !eventsPerFormer.has(i.id)).length,
    },
    after: {
      items: result.items.length,
      byKind: count(result.items.map((i) => primaryKind(i.keys))),
      singleMessageItems: result.items.filter((i) => i.events.length === 1).length,
    },
    outcomes,
    needsModel: result.decisions.filter((d) => d.needsModel).length,
    ambiguous: result.decisions.filter((d) => d.ambiguous).length,
    reports: {
      bySignal: count(result.decisions.flatMap((d) => (d.kind === "report" && d.report ? [d.report] : []))),
      bySignalStatus: bySignalStatus(result.decisions),
      // Reports classified as asks: they create no item here (the pipeline's capped escalation is still to carry over)
      asks: result.decisions.filter((d) => d.kind === "report" && (d.status === "blocked_on_human" || d.status === "needs_decision")).length,
      messages: reportEvents.length,
      alreadyFlaggedDigest: reportEvents.filter((id) => digestFlagged.has(id)).length,
      newlyDetected: reportEvents.filter((id) => !digestFlagged.has(id)).length,
    },
    notifications: result.decisions.filter((d) => d.kind === "notification").length,
    activityNotItem: outcomes.activity ?? 0,
    merges: result.merges.length,
    promotions: outcomes.promoted ?? 0,
    itemsPerTicket: {
      before: spread([...touchingBefore.values()].map((s) => s.size)),
      after: spread([...touchingAfter.values()].map((s) => s.size)),
      holdersAfter: spread([...holderCounts.values()]),
    },
    formerItems: { carried: [...liveIds].filter((id) => carried.has(id)).length, notCarried: [...liveIds].filter((id) => !carried.has(id)).length },
    notes: RELINK_NOTES,
  };
}

/** Lane tags agents open messages with ("[intake] …"), as candidate subject rules, most used first */
export function subjectRuleCandidates(snapshot: Snapshot, limit = 20): Array<{ sender: string; lane: string; messages: number; pattern: string }> {
  const counts = new Map<string, { sender: string; lane: string; messages: number }>();
  for (const e of snapshot.events) {
    // Agents only: not people, and not senders of unknown kind
    if (e.senderKind !== "agent" || !e.agentId) continue;
    const m = /^\s*\[([\w-]{2,32})\]\s+\S/.exec(e.text.slice(0, 200));
    if (!m) continue;
    const id = `${e.agentId}\u0000${m[1].toLowerCase()}`;
    const c = counts.get(id) ?? { sender: e.agentId, lane: m[1].toLowerCase(), messages: 0 };
    c.messages++;
    counts.set(id, c);
  }
  return [...counts.values()]
    .sort((a, b) => b.messages - a.messages)
    .slice(0, limit)
    .map((c) => ({ ...c, pattern: String.raw`^\[(?<lane>${c.lane})\]\s+(?<subject>[^(:—\-\n]+)` }));
}

// --- Running it ---------------------------------------------------------------------------------------------------

const RELINK_FLAGS = ["db", "prefixes", "rules"] as const;

/** The CLI's options. An unknown option, or one given without a value (or with another option as its value), is an error. */
export function parseRelinkArgs(argv: string[]): { db?: string; prefixes?: string[]; rules?: string } {
  const out: { db?: string; prefixes?: string[]; rules?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag.startsWith("--") ? flag.slice(2) : null;
    if (!name || !(RELINK_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`Unexpected argument ${JSON.stringify(flag)} (options: --${RELINK_FLAGS.join(", --")})`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new Error(`--${name} needs a value`);
    i++;
    if (name === "prefixes") out.prefixes = value.split(",").map((p) => p.trim()).filter(Boolean);
    else out[name as "db" | "rules"] = value;
  }
  return out;
}

/** Subject rules from a YAML file: a list of { pattern, sender?, channel? }, or { subjectRules: [...] } */
export function loadSubjectRules(path: string): SubjectRule[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf-8"));
  } catch {
    // Not the parser's message: its code frame would echo the file's lines
    throw new Error("Subject rules: couldn't read the file as YAML");
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { subjectRules?: unknown })?.subjectRules;
  if (!Array.isArray(list)) throw new Error("Subject rules: expected a list of { pattern, sender?, channel? }");
  return list.map((r, i) => {
    const rule = r as SubjectRule;
    if (typeof rule?.pattern !== "string") throw new Error(`Subject rule ${i + 1}: pattern is required`);
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern);
    } catch {
      throw new Error(`Subject rule ${i + 1}: the pattern isn't a valid regular expression`);
    }
    if (!re.source.includes("(?<subject>")) throw new Error(`Subject rule ${i + 1}: the pattern needs a (?<subject>…) group`);
    return { pattern: rule.pattern, sender: rule.sender, channel: rule.channel };
  });
}

/**
 * Ticket patterns and prefixes as the engine reads them: config/default.yaml with config/local.yaml over it, and the
 * configured prefixes. Without a config (a bare directory) the default pattern, and no prefixes.
 */
function extraction(root: string): { patterns: string[]; prefixes: string[] } {
  if (!existsSync(join(root, "config", "default.yaml"))) return { patterns: [DEFAULT_TICKET_PATTERN], prefixes: [] };
  const config = loadConfig(root);
  return {
    patterns: config.extractors.ticketPatterns.length ? config.extractors.ticketPatterns : [DEFAULT_TICKET_PATTERN],
    prefixes: knownTicketPrefixes(config.taskAdapter.ticketPrefixes),
  };
}

export interface RelinkOptions {
  dbPath: string;
  /** The project root; reports go to <root>/eval-data/relink/ and nowhere else */
  root: string;
  /** Ticket prefixes (e.g. ["OPS-"]); by default the configured ones and those the tracker confirmed, else any KEY-123 */
  prefixes?: string[];
  subjectRules?: SubjectRule[];
  /** Aborted (e.g. on SIGINT): the run stops at its next step, removes its copy and writes no reports */
  signal?: AbortSignal;
  /** For tests: passed to openReadOnly */
  openHooks?: OpenReadOnlyHooks;
}

/** Thrown when a run was stopped before it wrote its reports */
export class RelinkStopped extends Error {
  constructor() {
    super("Stopped before writing any reports");
  }
}

/** Lets the event loop run (and a signal's handler with it), then stops if the run was aborted */
async function checkpoint(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((done) => setImmediate(done));
  if (signal?.aborted) throw new RelinkStopped();
}

export interface RelinkRun {
  outDir: string;
  files: string[];
  summary: RelinkSummary;
}

/**
 * A private (0700) directory directly under the project's eval-data/: <root>/eval-data/relink by default, or another
 * one such as eval-data/linking. Refused if either directory is a symlink or resolves anywhere else, so the reports
 * can't be redirected out of the project's gitignored eval-data/.
 */
export function prepareOutDir(root: string, sub: string = RELINK_OUT_DIR): string {
  const name = sub.startsWith(`eval-data${sep}`) ? sub.slice(`eval-data${sep}`.length) : "";
  if (!name || name !== basename(name) || name === "." || name === "..") throw new Error(`Refusing to write outside eval-data/: ${sub}`);
  const realRoot = realpathSync(root);
  const outDir = join(realRoot, "eval-data", name);
  for (const dir of [join(realRoot, "eval-data"), outDir]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing to write: ${dir} is a symlink`);
    mkdirSync(dir, { mode: 0o700 , recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) throw new Error(`Refusing to write: ${dir} resolves elsewhere`);
  }
  chmodSync(outDir, 0o700);
  return outDir;
}

/** Writes one file in `outDir`: to a fresh private file (never through a link, never over one), then renamed into place */
export function writePrivateFile(outDir: string, name: string, content: string): string {
  const path = join(outDir, name);
  if (dirname(path) !== outDir) throw new Error(`Refusing to write outside ${outDir}: ${name}`);
  const temp = join(outDir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    // A failed write leaves no partial temp file behind
    rmSync(temp, { force: true });
    throw err;
  }
  return path;
}

export async function runRelink(options: RelinkOptions): Promise<RelinkRun> {
  const { signal } = options;
  if (signal?.aborted) throw new RelinkStopped();
  const source = openReadOnly(options.dbPath, options.openHooks);
  const copyStable = source.stable;
  let snapshot: Snapshot;
  try {
    await checkpoint(signal);
    snapshot = loadSnapshot(source.db);
    await checkpoint(signal);
  } finally {
    source.close();
  }

  const configured = extraction(options.root);
  // As the engine does: the configured prefixes and those the tracker taught it; --prefixes replaces both
  const prefixes = options.prefixes?.length
    ? knownTicketPrefixes(options.prefixes)
    : knownTicketPrefixes(configured.prefixes, { getValidIdPrefixes: () => snapshot.trackerPrefixes });
  const extractor = new DefaultExtractor({ ticketPatterns: configured.patterns, prPatterns: [], ticketPrefixes: prefixes });
  const result = replay(snapshot, {
    extractTickets: (text) => extractor.extractWorkItemIds(text),
    subjectRules: options.subjectRules,
  });
  const summary = summarize(snapshot, result);
  await checkpoint(signal);

  const titles = new Map(snapshot.items.map((i) => [i.id, i.title]));
  const report = {
    generatedAt: new Date().toISOString(),
    database: basename(options.dbPath),
    ticketPrefixes: prefixes,
    subjectRules: options.subjectRules?.length ?? 0,
    // False when the database kept changing while it was copied: the copy is consistent, but may be mid-update
    copyStable,
    summary,
  };
  /** For review: the title of the current item its main key names (its ticket's), else the one it takes most events from */
  const titleOf = (item: ProposedItem): string => {
    const kind = primaryKind(item.keys);
    const named = item.keys
      .filter((k) => keyKind(k) === kind)
      .map((k) => (kind === "thread" ? k : k.slice(k.indexOf(":") + 1)));
    for (const id of [...named, ...item.formerItems.map((f) => f.id)]) {
      const title = titles.get(id);
      if (title) return title;
    }
    return "";
  };
  const items = result.items.map((i) => ({
    id: i.id,
    kind: primaryKind(i.keys),
    title: titleOf(i),
    keys: i.keys,
    createdBy: i.createdBy,
    events: i.events,
    threads: i.threads,
    collapses: i.formerItems,
    mergedFrom: i.mergedFrom,
  }));
  const carried = new Set(result.items.flatMap((i) => i.formerItems.map((f) => f.id)));
  const notCarried = snapshot.items.filter((i) => !i.mergedInto && !carried.has(i.id)).map((i) => i.id);

  // The last chance to stop before anything is written
  await checkpoint(signal);
  const outDir = prepareOutDir(options.root);
  const files = {
    "summary.json": JSON.stringify(report, null, 2) + "\n",
    "items.json": JSON.stringify({ proposed: items, formerItemsNotCarried: notCarried }, null, 2) + "\n",
    "merges.json": JSON.stringify(result.merges, null, 2) + "\n",
    "decisions.jsonl": result.decisions.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "subject-rule-candidates.json": JSON.stringify(subjectRuleCandidates(snapshot), null, 2) + "\n",
  };
  const written = Object.entries(files).map(([name, content]) => writePrivateFile(outDir, name, content));
  return { outDir, files: written, summary };
}
