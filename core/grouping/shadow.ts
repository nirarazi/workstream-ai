// core/grouping/shadow.ts — The v2 grouping in shadow mode: computed beside the current linker, changing nothing shown
//
// Plan step 6 (docs/work-model.md §9). After a poll the engine regroups every message (core/grouping/), applying the
// operator's live constraints, and replaces two tables: v2_cases (each case, its stream, keys and status) and
// v2_assignments (each message's case, why it joined, and the message that drew it in). Nothing reads them for the
// inbox yet; the lab and later steps do. A case's id is stable across runs while its first message is: "case:" and a
// hash of that message's key. A run is skipped when no message has been added since the last.

import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { DefaultExtractor } from "../graph/extractors/default.js";
import type { ClusterOptions, Placement } from "./cluster.js";
import { groupMessages } from "./index.js";
import { actorOfHandle, loadActorNames, loadGroupingMessages, type LoadedMessage } from "./load.js";
import { findAsks, type Ask } from "./asks.js";
import { casesFrom, type Case, type Stream } from "./streams.js";

export const SHADOW_SQL = `
CREATE TABLE IF NOT EXISTS v2_cases (
  id          TEXT PRIMARY KEY,
  stream      TEXT NOT NULL,
  keys        TEXT NOT NULL DEFAULT '[]',
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  status      TEXT,
  waiting     INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_cases_stream ON v2_cases(stream);
CREATE TABLE IF NOT EXISTS v2_assignments (
  message_key TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  via         TEXT,
  reasons     TEXT NOT NULL DEFAULT '[]',
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_assignments_case ON v2_assignments(case_id);
-- What the recognizers say about each message: the graph's edges from a message to a key, a subject or an actor
-- (docs/work-model.md §3, "The graph"). claim: kind (work, report, telemetry, chatter), about, mention, ask.
-- relation: for about, how it's known (key, tagged, named); for ask, its strength (blocks, asks).
CREATE TABLE IF NOT EXISTS v2_claims (
  message_key TEXT NOT NULL,
  claim       TEXT NOT NULL,
  value       TEXT NOT NULL,
  relation    TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_claims_value ON v2_claims(value, claim);
CREATE INDEX IF NOT EXISTS idx_v2_claims_message ON v2_claims(message_key);
`;

/** A case id that holds while the case's first message does */
export function stableCaseId(firstMessageKey: string): string {
  return `case:${createHash("sha256").update(firstMessageKey).digest("hex").slice(0, 16)}`;
}

/**
 * The operator's live, unsuspended constraints, by grouping message key ("<platform>:<channel>:<message id>"), from
 * the observations they name. Pins name a key, not a message, and stay as they are.
 */
export function constraintsByMessage(db: BetterSqlite3.Database): NonNullable<ClusterOptions["constraints"]> {
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  if (!has("constraints") || !has("observations")) return [];
  const rows = db.prepare(`
    SELECT c.kind, c.a, c.b,
      (SELECT o.platform || ':' || o.container_id || ':' || o.message_id FROM observations o WHERE o.dedupe_key = c.a) AS ma,
      (SELECT o.platform || ':' || o.container_id || ':' || o.message_id FROM observations o WHERE o.dedupe_key = c.b) AS mb
    FROM constraints c
    WHERE c.retired_at IS NULL AND c.suspended_at IS NULL AND c.kind IN ('must_link', 'cannot_link', 'pin', 'not_an_item')
  `).all() as Array<{ kind: "must_link" | "cannot_link" | "pin" | "not_an_item"; a: string; b: string | null; ma: string | null; mb: string | null }>;
  const out: NonNullable<ClusterOptions["constraints"]> = [];
  for (const r of rows) {
    if (!r.ma) continue;
    if (r.kind === "pin") out.push({ kind: "pin", a: r.ma, b: r.b });
    else if (r.kind === "not_an_item") out.push({ kind: "not_an_item", a: r.ma, b: null });
    else if (r.mb) out.push({ kind: r.kind, a: r.ma, b: r.mb });
  }
  return out;
}

/**
 * What a grouping depends on, cheaply: the events (added, and reclassified into or out of waiting or Needs me), the
 * operator's constraints (added, retired or suspended), and the agents (their names make actors, and whether each is a
 * bot its sender kind). A grouping is recomputed only when this changes.
 */
export function groupingVersion(db: BetterSqlite3.Database): string {
  const e = db.prepare(`
    SELECT COUNT(*) AS n, MAX(rowid) AS last,
      TOTAL(status IN ('blocked_on_human', 'needs_decision')) AS waiting, TOTAL(targeted_at_operator) AS targeted
    FROM events
  `).get() as { n: number; last: number | null; waiting: number; targeted: number };
  const hasConstraints = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'constraints'").get() !== undefined;
  const c = hasConstraints
    ? db.prepare(`
        SELECT COUNT(*) AS n, MAX(rowid) AS last, TOTAL(retired_at IS NOT NULL) AS retired, TOTAL(suspended_at IS NOT NULL) AS suspended
        FROM constraints
      `).get() as { n: number; last: number | null; retired: number; suspended: number }
    : { n: 0, last: 0, retired: 0, suspended: 0 };
  const bot = (db.prepare("SELECT name FROM pragma_table_info('agents')").all() as Array<{ name: string }>).some((r) => r.name === "bot_type")
    ? "COALESCE(is_bot, '') || '|' || COALESCE(bot_type, '')"
    : "''";
  const agents = db.prepare(`SELECT group_concat(row, char(10)) AS rows FROM (SELECT id || '|' || name || '|' || ${bot} AS row FROM agents ORDER BY id)`)
    .get() as { rows: string | null };
  const agentsHash = createHash("sha256").update(agents.rows ?? "").digest("hex").slice(0, 12);
  return [e.n, e.last ?? 0, e.waiting, e.targeted, c.n, c.last ?? 0, c.retired, c.suspended, agentsHash].join(":");
}

export interface Grouping {
  messages: LoadedMessage[];
  placements: Map<string, Placement>;
  /** Cases by their stable id (stableCaseId) */
  cases: Case[];
  streams: Stream[];
  actors: Map<string, string>;
  /** Asks, their caseId the stable id */
  asks: Ask[];
}

/**
 * The v2 grouping of everything in the graph, with the operator's live constraints applied, cases under their stable
 * ids: what shadow mode stores and the lab shows, computed one way so the two always agree
 */
export function computeGrouping(db: BetterSqlite3.Database): Grouping {
  const messages = loadGroupingMessages(db);
  const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
  const placements = groupMessages(messages, {
    extractTickets: (t) => extractor.extractWorkItemIds(t),
    constraints: constraintsByMessage(db),
  });
  const raw = casesFrom(placements, new Map(messages.map((m) => [m.key, { at: m.at, channelId: m.channelId }])));
  const stable = new Map(raw.cases.map((c) => [c.id, stableCaseId(c.members[0].key)]));
  const cases = raw.cases.map((c) => ({ ...c, id: stable.get(c.id)! }));
  const streams = raw.streams.map((st) => ({ ...st, cases: st.cases.map((id) => stable.get(id)!) }));
  const actors = loadActorNames(db);
  const asks = findAsks(messages, placements, new Map([...actors].map(([id, name]) => [name.trim().toLowerCase(), id])), actorOfHandle(actors))
    .map((a) => ({ ...a, caseId: a.caseId ? stable.get(a.caseId) ?? null : null }));
  return { messages, placements, cases, streams, actors, asks };
}

export interface ShadowRun {
  messages: number;
  cases: number;
  streams: number;
  ms: number;
}

/**
 * Regroups and replaces the shadow tables, unless nothing it depends on (groupingVersion) has changed since
 * `lastVersion`; returns the run, or null
 */
export function runShadowGrouping(db: BetterSqlite3.Database, lastVersion: string | null): { version: string; run: ShadowRun | null } {
  const version = groupingVersion(db);
  if (version === lastVersion) return { version, run: null };
  const started = Date.now();
  db.exec(SHADOW_SQL);
  const { messages, placements, cases, streams, asks } = computeGrouping(db);
  const byKey = new Map(messages.map((m) => [m.key, m]));
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    db.exec("DELETE FROM v2_cases; DELETE FROM v2_assignments; DELETE FROM v2_claims;");
    const insertClaim = db.prepare("INSERT INTO v2_claims (message_key, claim, value, relation, computed_at) VALUES (?, ?, ?, ?, ?)");
    for (const [key, p] of placements) {
      insertClaim.run(key, "kind", p.recognized.kind, null, now);
      if (p.recognized.about) insertClaim.run(key, "about", p.recognized.about, p.recognized.aboutBy, now);
      for (const mention of p.recognized.mentions) insertClaim.run(key, "mention", mention, null, now);
    }
    for (const a of asks) insertClaim.run(a.message, "ask", a.to, a.strength, now);
    const insertCase = db.prepare(`
      INSERT OR REPLACE INTO v2_cases (id, stream, keys, first_at, last_at, size, status, waiting, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAssignment = db.prepare(`
      INSERT OR REPLACE INTO v2_assignments (message_key, case_id, via, reasons, computed_at) VALUES (?, ?, ?, ?, ?)
    `);
    for (const c of cases) {
      const id = c.id;
      const status = byKey.get(c.members[c.members.length - 1].key)?.status ?? null;
      const waiting = status === "blocked_on_human" || status === "needs_decision" ? 1 : 0;
      insertCase.run(id, c.stream, JSON.stringify(c.keys), c.first, c.last, c.members.length, status, waiting, now);
      for (const m of c.members) insertAssignment.run(m.key, id, m.via, JSON.stringify(m.reasons), now);
    }
  });
  write();
  return { version, run: { messages: messages.length, cases: cases.length, streams: streams.length, ms: Date.now() - started } };
}
