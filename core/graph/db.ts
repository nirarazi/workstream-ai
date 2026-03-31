// core/graph/db.ts — SQLite connection and schema management

import BetterSqlite3 from "better-sqlite3";
import type BetterSqlite3Type from "better-sqlite3";
import { createLogger } from "../logger.js";

const log = createLogger("graph:db");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  role TEXT,
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

CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_work_item_id ON events(work_item_id);
CREATE INDEX IF NOT EXISTS idx_threads_work_item_id ON threads(work_item_id);
CREATE INDEX IF NOT EXISTS idx_enrichments_work_item_id ON enrichments(work_item_id);
`;

export class Database {
  readonly db: BetterSqlite3Type.Database;

  constructor(dbPath: string = "atc.db") {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
    log.info("Database opened", dbPath);
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL);
    log.debug("Schema initialized");
  }

  prepare<T>(sql: string): BetterSqlite3Type.Statement<T[]> {
    return this.db.prepare<T[]>(sql);
  }

  close(): void {
    this.db.close();
    log.info("Database closed");
  }
}
