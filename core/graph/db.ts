// core/graph/db.ts — SQLite connection and schema management

import BetterSqlite3 from "better-sqlite3";
import type BetterSqlite3Type from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

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

CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_work_item_id ON events(work_item_id);
CREATE INDEX IF NOT EXISTS idx_threads_work_item_id ON threads(work_item_id);
CREATE INDEX IF NOT EXISTS idx_enrichments_work_item_id ON enrichments(work_item_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_usage_caller ON llm_usage(caller);
`;

export class Database {
  readonly db: BetterSqlite3Type.Database;

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
    // e.g. "https://site.atlassian.net/rest/api/3/issue/25937" → "https://site.atlassian.net/browse/AI-320"
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
  }

  prepare<T>(sql: string): BetterSqlite3Type.Statement<T[]> {
    return this.db.prepare<T[]>(sql);
  }

  close(): void {
    this.db.close();
    log.info("Database closed");
  }
}
