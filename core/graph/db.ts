// core/graph/db.ts — SQLite connection and schema management

import BetterSqlite3 from "better-sqlite3";
import type BetterSqlite3Type from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import { legacyKeyOf } from "./item-keys.js";

const log = createLogger("graph:db");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  role TEXT,
  avatar_url TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  external_status TEXT,
  assignee TEXT,
  url TEXT,
  current_atc_status TEXT,
  current_confidence REAL,
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  platform_meta TEXT NOT NULL DEFAULT '{}',
  platform TEXT NOT NULL,
  work_item_id TEXT REFERENCES work_items(id),
  last_activity TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL,
  work_item_id TEXT REFERENCES work_items(id),
  agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrichments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  source TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_cursors (
  channel_id TEXT PRIMARY KEY,
  last_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  summary_text TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  latest_event_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  token_source TEXT NOT NULL,
  cost REAL,
  cost_source TEXT,
  model TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_work_items (
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  work_item_id  TEXT NOT NULL REFERENCES work_items(id),
  relation      TEXT NOT NULL DEFAULT 'mentioned',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (thread_id, work_item_id)
);

-- One-off upkeep the engine still owes the stored data, e.g. digest_backfill = pending
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Work items a message puts in front of the operator by its own line for them (the model's per-item breakdown says
-- blocked on, or a decision for, the operator): it counts for them though they're only mentioned in its thread
CREATE TABLE IF NOT EXISTS event_targets (
  event_id     TEXT NOT NULL REFERENCES events(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY (event_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_event_targets_work_item ON event_targets(work_item_id);

-- Work items a message is about besides its thread's own: the operator's message about items it names counts for them
CREATE TABLE IF NOT EXISTS event_subjects (
  event_id     TEXT NOT NULL REFERENCES events(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  -- The message's own line for this item (status, and who it waits on), where it gave one
  status       TEXT,
  action_required_from TEXT,
  confidence   REAL,
  PRIMARY KEY (event_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_event_subjects_work_item ON event_subjects(work_item_id);

-- What a digest (a message naming several work items) says about each, against what the app already believes
CREATE TABLE IF NOT EXISTS digest_checks (
  event_id       TEXT NOT NULL REFERENCES events(id),
  work_item_id   TEXT NOT NULL REFERENCES work_items(id),
  digest_status  TEXT NOT NULL,
  digest_targeted INTEGER NOT NULL DEFAULT 0,
  -- 1 when the claim is the digest's own line for the item, 0 when it's the whole message's status
  from_line      INTEGER NOT NULL DEFAULT 1,
  item_status    TEXT,
  -- 1 agrees, 0 disagrees, NULL when the app had no status for the item yet
  agrees         INTEGER,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolution     TEXT,
  -- What the judge made of a disagreement: app, digest or unsure (unsure ones wait for the operator)
  judge_verdict  TEXT,
  judge_reason   TEXT,
  judged_at      TEXT,
  PRIMARY KEY (event_id, work_item_id)
);

-- What merging a work item moved to the item it was merged into, so unmerging puts back exactly that (JSON).
-- No foreign keys: the record holds IDs as JSON anyway, and unmerging skips what no longer exists.
CREATE TABLE IF NOT EXISTS work_item_merges (
  source_id  TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL,
  merged_at  TEXT NOT NULL,
  moved      TEXT NOT NULL
);

-- The keys that name a work item (core/graph/item-keys.ts): ticket:OPS-101, pr:…, mcp:…, legacy thread:…. A key is
-- held by one live item (retired_at NULL); retired rows stay, so where a key pointed before is kept.
CREATE TABLE IF NOT EXISTS item_keys (
  key        TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES work_items(id),
  source     TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  decided_by TEXT NOT NULL,
  evidence   TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_keys_key ON item_keys(key) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_keys_item ON item_keys(item_id);

-- L0: each message or report seen, once (core/observations/types.ts). Append-only; JSON columns hold the lists.
CREATE TABLE IF NOT EXISTS observations (
  id             TEXT PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  platform       TEXT NOT NULL,
  container_kind TEXT NOT NULL,
  container_id   TEXT NOT NULL,
  container_name TEXT,
  message_id     TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  author_platform TEXT NOT NULL,
  author_id      TEXT NOT NULL,
  sender_kind    TEXT NOT NULL,
  own_text       TEXT NOT NULL,
  quoted         TEXT NOT NULL DEFAULT '[]',
  forwarded      TEXT NOT NULL DEFAULT '[]',
  participants   TEXT NOT NULL DEFAULT '[]',
  refs           TEXT NOT NULL DEFAULT '{}',
  external_refs  TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_message ON observations(platform, container_id, message_id);

-- Edges between observations (docs/work-model.md, section 3, "The graph"): from an observation to the dedupeKey of one
-- it replies to, quotes or forwards. By key, not id: the other may not have been seen yet.
CREATE TABLE IF NOT EXISTS observation_refs (
  from_id TEXT NOT NULL REFERENCES observations(id),
  to_key  TEXT NOT NULL,
  kind    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_observation_refs_to ON observation_refs(to_key, kind);

CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_work_item_id ON events(work_item_id);
CREATE INDEX IF NOT EXISTS idx_threads_work_item_id ON threads(work_item_id);
CREATE INDEX IF NOT EXISTS idx_enrichments_work_item_id ON enrichments(work_item_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_usage_caller ON llm_usage(caller);
CREATE INDEX IF NOT EXISTS idx_twi_work_item ON thread_work_items(work_item_id);
`;

export class Database {
  readonly db: BetterSqlite3Type.Database;
  /** Messages stored before events.digest existed still need marking (once; cleared when it's done) */
  get digestBackfillPending(): boolean {
    return this.db.prepare("SELECT 1 FROM meta WHERE key = 'digest_backfill'").get() !== undefined;
  }

  constructor(dbPath: string = "workstream.db") {
    // Migrate legacy "atc.db" → "workstream.db" if the new name doesn't exist yet
    if (!fs.existsSync(dbPath)) {
      const legacyPath = path.join(path.dirname(dbPath) || ".", "atc.db");
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, dbPath);
        // Also move WAL/SHM files if present
        for (const suffix of ["-wal", "-shm"]) {
          if (fs.existsSync(legacyPath + suffix)) {
            fs.renameSync(legacyPath + suffix, dbPath + suffix);
          }
        }
        log.info(`Migrated database: ${legacyPath} → ${dbPath}`);
      }
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
    log.info("Database opened", dbPath);
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    log.debug("Schema initialized");
  }

  private migrate(): void {
    // Add avatar_url column to agents table if it doesn't exist (added in v0.2)
    const cols = this.db.pragma("table_info(agents)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "avatar_url")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN avatar_url TEXT");
      log.info("Migration: added avatar_url column to agents");
    }

    // Migrate channel_is_private → platform_meta JSON column
    const threadCols = this.db.pragma("table_info(threads)") as Array<{ name: string }>;
    if (!threadCols.some((c) => c.name === "platform_meta")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN platform_meta TEXT NOT NULL DEFAULT '{}'");
      log.info("Migration: added platform_meta column to threads");
      // Convert any existing channel_is_private = 1 rows to platform_meta JSON
      if (threadCols.some((c) => c.name === "channel_is_private")) {
        const updated = this.db.prepare(
          "UPDATE threads SET platform_meta = '{\"isPrivate\":true}' WHERE channel_is_private = 1"
        ).run();
        if (updated.changes > 0) {
          log.info(`Migration: converted ${updated.changes} channel_is_private rows to platform_meta`);
        }
      }
    }

    // Convert Slack epoch timestamps (e.g. "1774958531.590819") to ISO 8601
    const slackTsCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE timestamp NOT LIKE '%-%'").get() as { n: number }
    ).n;
    if (slackTsCount > 0) {
      this.db.exec(`
        UPDATE events
        SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', CAST(timestamp AS REAL), 'unixepoch')
        WHERE timestamp NOT LIKE '%-%'
      `);
      log.info(`Migration: converted ${slackTsCount} Slack timestamps to ISO 8601`);
    }

    // Fix Jira URLs: convert REST API URLs to browse URLs
    // e.g. "https://site.atlassian.net/rest/api/3/issue/10001" → "https://site.atlassian.net/browse/OPS-1"
    const jiraApiUrlCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE url LIKE '%/rest/api/%'").get() as { n: number }
    ).n;
    if (jiraApiUrlCount > 0) {
      // Extract base URL (everything before /rest/) and combine with the work item ID as key
      this.db.exec(`
        UPDATE work_items
        SET url = SUBSTR(url, 1, INSTR(url, '/rest/') - 1) || '/browse/' || id
        WHERE url LIKE '%/rest/api/%'
      `);
      log.info(`Migration: fixed ${jiraApiUrlCount} Jira URLs from REST API to browse format`);
    }

    // Deduplicate events: remove duplicate (message_id, thread_id) rows, keeping earliest
    const dupCount = (
      this.db.prepare(`
        SELECT COUNT(*) AS n FROM events
        WHERE id NOT IN (
          SELECT MIN(id) FROM events GROUP BY message_id, thread_id
        )
      `).get() as { n: number }
    ).n;
    if (dupCount > 0) {
      this.db.exec(`
        DELETE FROM events
        WHERE id NOT IN (
          SELECT MIN(id) FROM events GROUP BY message_id, thread_id
        )
      `);
      log.info(`Migration: removed ${dupCount} duplicate events`);
    }

    // Add unique constraint on (message_id, thread_id) to prevent future duplicates
    const indices = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_message_thread_unique'"
    ).get() as { name: string } | undefined;
    if (!indices) {
      this.db.exec("CREATE UNIQUE INDEX idx_events_message_thread_unique ON events(message_id, thread_id)");
      log.info("Migration: added unique index on events(message_id, thread_id)");
    }

    // Add manually_linked column to threads table
    const threadColsForManual = this.db.pragma("table_info(threads)") as Array<{ name: string }>;
    if (!threadColsForManual.some((c) => c.name === "manually_linked")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN manually_linked INTEGER DEFAULT 0");
      log.info("Migration: added manually_linked column to threads");
    }

    // Add entry_type column to events table
    const eventCols = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === "entry_type")) {
      this.db.exec("ALTER TABLE events ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'progress'");
      this.db.exec(`
        UPDATE events SET entry_type = CASE
          WHEN status IN ('blocked_on_human', 'needs_decision') THEN 'block'
          WHEN status = 'noise' THEN 'noise'
          ELSE 'progress'
        END
      `);
      log.info("Migration: added entry_type column to events and backfilled");
    }

    // Add targeted_at_operator column to events table
    const eventColsForTarget = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColsForTarget.some((c) => c.name === "targeted_at_operator")) {
      this.db.exec("ALTER TABLE events ADD COLUMN targeted_at_operator INTEGER NOT NULL DEFAULT 1");
      log.info("Migration: added targeted_at_operator column to events");
    }

    // Add action_required_from and next_action columns to events table
    const eventColsForAction = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColsForAction.some((c) => c.name === "action_required_from")) {
      this.db.exec("ALTER TABLE events ADD COLUMN action_required_from TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE events ADD COLUMN next_action TEXT DEFAULT NULL");
      log.info("Migration: added action_required_from and next_action columns to events");
    }

    // Add digest: the event is a message naming several work items, which informs them but doesn't decide them
    const eventColsForDigest = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColsForDigest.some((c) => c.name === "digest")) {
      this.db.exec("ALTER TABLE events ADD COLUMN digest INTEGER NOT NULL DEFAULT 0");
      // The engine marks earlier digests once (it has the extractors). Kept in the database, so it isn't lost when
      // the MCP server or a CLI opens it first, or the engine stops before it's done.
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('digest_backfill', 'pending')").run();
      log.info("Migration: added digest column to events");
    }

    // Add the judge's columns to digest_checks (created by an earlier build without them)
    const checkCols = this.db.pragma("table_info(digest_checks)") as Array<{ name: string }>;
    if (!checkCols.some((c) => c.name === "from_line")) {
      // Recorded before the column existed: where a claim came from isn't known, so it isn't taken as the item's line.
      // Together, so a crash between them can't leave those rows taken as lines
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE digest_checks ADD COLUMN from_line INTEGER NOT NULL DEFAULT 1");
        this.db.exec("UPDATE digest_checks SET from_line = 0");
      })();
      log.info("Migration: added from_line to digest_checks");
    }
    for (const column of ["judge_verdict", "judge_reason", "judged_at"]) {
      if (!checkCols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE digest_checks ADD COLUMN ${column} TEXT`);
        log.info(`Migration: added ${column} to digest_checks`);
      }
    }
    // What later digests said about an item
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_digest_checks_item ON digest_checks(work_item_id, created_at)");
    // The operator's queue: what the judge left unsure
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_digest_checks_unsure ON digest_checks(created_at)
      WHERE judge_verdict = 'unsure' AND resolved_at IS NULL`);
    // The judge's queue: open disagreements, oldest first
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_digest_checks_open ON digest_checks(created_at)
      WHERE agrees = 0 AND resolved_at IS NULL AND judged_at IS NULL`);

    // event_subjects' line columns (a table created by an earlier build of this change lacks them)
    const subjectCols = this.db.pragma("table_info(event_subjects)") as Array<{ name: string }>;
    for (const [column, type] of [["status", "TEXT"], ["action_required_from", "TEXT"], ["confidence", "REAL"]]) {
      if (!subjectCols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE event_subjects ADD COLUMN ${column} ${type}`);
    }

    // Add is_bot column to agents table
    const agentColsForBot = this.db.pragma("table_info(agents)") as Array<{ name: string }>;
    if (!agentColsForBot.some((c) => c.name === "is_bot")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN is_bot INTEGER DEFAULT NULL");
      log.info("Migration: added is_bot column to agents");
    }

    // Add bot_type column to agents table (null = unclassified, "agent" = AI agent, "notification" = notification bot)
    if (!agentColsForBot.some((c) => c.name === "bot_type")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN bot_type TEXT DEFAULT NULL");
      log.info("Migration: added bot_type column to agents");
    }

    // Add pinned and dismissed_at columns to work_items table
    const workItemCols = this.db.pragma("table_info(work_items)") as Array<{ name: string }>;
    if (!workItemCols.some((c) => c.name === "pinned")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      log.info("Migration: added pinned column to work_items");
    }
    if (!workItemCols.some((c) => c.name === "dismissed_at")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN dismissed_at TEXT DEFAULT NULL");
      log.info("Migration: added dismissed_at column to work_items");
    }

    // Why an item was dismissed: "operator" (a judgment: not relevant / false positive) or "expired"
    // (no activity for inbox.expireAfterDays). Expired items must not count as classifier corrections.
    const wiColsDismiss = this.db.pragma("table_info(work_items)") as Array<{ name: string }>;
    if (!wiColsDismiss.some((c) => c.name === "dismiss_reason")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN dismiss_reason TEXT DEFAULT NULL");
      this.db.exec("UPDATE work_items SET dismiss_reason = 'operator' WHERE dismissed_at IS NOT NULL");
      log.info("Migration: added dismiss_reason column to work_items");
    }

    // Add merged_into column to work_items table (for work item merge support)
    const wiColsMerge = this.db.pragma("table_info(work_items)") as Array<{ name: string }>;
    if (!wiColsMerge.some((c) => c.name === "merged_into")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN merged_into TEXT DEFAULT NULL");
      log.info("Migration: added merged_into column to work_items");
    }

    // Add status_at: when the message that last set a work item's status was posted
    if (!wiColsMerge.some((c) => c.name === "status_at")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN status_at TEXT DEFAULT NULL");
      log.info("Migration: added status_at column to work_items");
    }

    // Add reopened_at: when a completed work item was brought back by a later message (cleared when it's closed)
    if (!wiColsMerge.some((c) => c.name === "reopened_at")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN reopened_at TEXT DEFAULT NULL");
      log.info("Migration: added reopened_at column to work_items");
    }

    this.backfillItemKeys();

    // The observation an event classified (rows stored before observations existed get theirs from the engine's backfill)
    const eventColsForObservation = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColsForObservation.some((c) => c.name === "observation_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN observation_id TEXT DEFAULT NULL");
      log.info("Migration: added observation_id column to events");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_observation ON events(observation_id)");

    // Edges for observations recorded before observation_refs existed, from their refs column (once)
    if (!this.db.prepare("SELECT 1 FROM meta WHERE key = 'observation_refs_backfill'").get()) {
      this.db.transaction(() => {
        this.db.exec(`
          INSERT OR IGNORE INTO observation_refs (from_id, to_key, kind)
          SELECT id, json_extract(refs, '$.repliesTo'), 'replies_to' FROM observations
          WHERE json_extract(refs, '$.repliesTo') IS NOT NULL;
          INSERT OR IGNORE INTO observation_refs (from_id, to_key, kind)
          SELECT o.id, q.value, 'quotes' FROM observations o, json_each(o.refs, '$.quotes') q;
          INSERT OR IGNORE INTO observation_refs (from_id, to_key, kind)
          SELECT o.id, f.value, 'forwards' FROM observations o, json_each(o.refs, '$.forwards') f;
        `);
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('observation_refs_backfill', 'done')").run();
      })();
    }

    // Backfill thread_work_items junction table from existing data
    const twiCount = (this.db.prepare("SELECT COUNT(*) AS n FROM thread_work_items").get() as { n: number }).n;
    if (twiCount === 0) {
      // Check if there's data to backfill
      const threadCount = (this.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE work_item_id IS NOT NULL").get() as { n: number }).n;
      if (threadCount > 0) {
        // Step 1: Primary rows from threads.work_item_id
        const primaryResult = this.db.prepare(`
          INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
          SELECT id, work_item_id, 'primary', last_activity
          FROM threads
          WHERE work_item_id IS NOT NULL
        `).run();
        log.info(`Migration: backfilled ${primaryResult.changes} primary junction rows from threads`);

        // Step 2: Mentioned rows from events whose work_item_id differs from thread's
        const mentionedResult = this.db.prepare(`
          INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
          SELECT e.thread_id, e.work_item_id, 'mentioned', e.timestamp
          FROM events e
          JOIN threads t ON e.thread_id = t.id
          WHERE e.work_item_id IS NOT NULL
            AND e.work_item_id != COALESCE(t.work_item_id, '')
        `).run();
        log.info(`Migration: backfilled ${mentionedResult.changes} mentioned junction rows from events`);

        // Step 3: Delete breakdown event duplicates (message_id contains ':')
        const breakdownResult = this.db.prepare(`
          DELETE FROM events WHERE message_id LIKE '%:%'
        `).run();
        log.info(`Migration: deleted ${breakdownResult.changes} breakdown duplicate events`);
      }
    }
  }

  /**
   * Gives each work item that has no key yet the key its id already was (item-keys.ts), and enrichments the ticket
   * key of their item. Idempotent: items with keys are left alone, so it runs on every start. A merged item's key goes
   * to the live item it was merged into, as a merge would have moved it, with a retired row for the item itself so
   * unmerging gives it back.
   */
  private backfillItemKeys(): void {
    const items = this.db.prepare(`
      SELECT id, source, merged_into, updated_at FROM work_items w
      WHERE NOT EXISTS (SELECT 1 FROM item_keys k WHERE k.item_id = w.id)
    `).all() as Array<{ id: string; source: string; merged_into: string | null; updated_at: string }>;
    if (items.length > 0) {
      const holder = this.db.prepare("SELECT item_id FROM item_keys WHERE key = ? AND retired_at IS NULL LIMIT 1");
      const mergedInto = this.db.prepare("SELECT merged_into FROM work_items WHERE id = ?");
      const insert = this.db.prepare(`
        INSERT INTO item_keys (key, item_id, source, confidence, decided_by, evidence, created_at, retired_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      let added = 0, skipped = 0;
      this.db.transaction(() => {
        for (const item of items) {
          const key = legacyKeyOf(item.id, item.source);
          if (!key) continue;
          // The live end of a merge chain (bounded, in case of a cycle)
          let live = item.id;
          for (let hops = 0, next = item.merged_into; next && hops < 20; hops++) {
            live = next;
            next = (mergedInto.get(next) as { merged_into: string | null } | undefined)?.merged_into ?? null;
          }
          const held = holder.get(key) as { item_id: string } | undefined;
          if (held && held.item_id !== live) {
            skipped++;
            continue;
          }
          if (live === item.id) {
            if (!held) insert.run(key, item.id, item.source, "backfill", null, now, null);
          } else {
            insert.run(key, item.id, item.source, "backfill", null, now, item.updated_at);
            if (!held) insert.run(key, live, item.source, "merge", item.id, now, null);
          }
          added++;
        }
      })();
      if (added > 0) log.info(`Migration: gave ${added} work items their keys`);
      if (skipped > 0) log.warn(`Migration: ${skipped} work items' keys are already another item's; left without one`);
    }

    const enrichmentCols = this.db.pragma("table_info(enrichments)") as Array<{ name: string }>;
    if (!enrichmentCols.some((c) => c.name === "key")) {
      this.db.exec("ALTER TABLE enrichments ADD COLUMN key TEXT DEFAULT NULL");
      log.info("Migration: added key column to enrichments");
    }
    this.db.exec(`
      UPDATE enrichments SET key = (
        SELECT k.key FROM item_keys k
        WHERE k.item_id = enrichments.work_item_id AND k.key LIKE 'ticket:%'
        ORDER BY k.retired_at IS NOT NULL, k.created_at LIMIT 1
      )
      WHERE key IS NULL
    `);
  }

  prepare<T>(sql: string): BetterSqlite3Type.Statement<T[]> {
    return this.db.prepare<T[]>(sql);
  }

  close(): void {
    this.db.close();
    log.info("Database closed");
  }
}
