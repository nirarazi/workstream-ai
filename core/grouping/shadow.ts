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
import type { ClusterOptions } from "./cluster.js";
import { groupMessages } from "./index.js";
import { loadActorNames, loadGroupingMessages } from "./load.js";
import { findAsks } from "./asks.js";
import { casesFrom } from "./streams.js";

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

export interface ShadowRun {
  messages: number;
  cases: number;
  streams: number;
  ms: number;
}

/** Regroups and replaces the shadow tables, unless nothing has been added since `lastVersion`; returns the run, or null */
export function runShadowGrouping(db: BetterSqlite3.Database, lastVersion: string | null): { version: string; run: ShadowRun | null } {
  const v = db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS last FROM events").get() as { n: number; last: number | null };
  const version = `${v.n}:${v.last ?? 0}`;
  if (version === lastVersion) return { version, run: null };
  const started = Date.now();
  db.exec(SHADOW_SQL);
  const messages = loadGroupingMessages(db);
  const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
  const placements = groupMessages(messages, {
    extractTickets: (t) => extractor.extractWorkItemIds(t),
    constraints: constraintsByMessage(db),
  });
  const byKey = new Map(messages.map((m) => [m.key, m]));
  const { cases, streams } = casesFrom(placements, new Map(messages.map((m) => [m.key, { at: m.at, channelId: m.channelId }])));
  const now = new Date().toISOString();
  const actors = loadActorNames(db);
  const asks = findAsks(messages, placements, new Map([...actors].map(([id, name]) => [name.trim().toLowerCase(), id])));
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
      const id = stableCaseId(c.members[0].key);
      const status = byKey.get(c.members[c.members.length - 1].key)?.status ?? null;
      const waiting = status === "blocked_on_human" || status === "needs_decision" ? 1 : 0;
      insertCase.run(id, c.stream, JSON.stringify(c.keys), c.first, c.last, c.members.length, status, waiting, now);
      for (const m of c.members) insertAssignment.run(m.key, id, m.via, JSON.stringify(m.reasons), now);
    }
  });
  write();
  return { version, run: { messages: messages.length, cases: cases.length, streams: streams.length, ms: Date.now() - started } };
}
