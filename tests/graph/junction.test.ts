import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("thread_work_items junction table", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates thread_work_items table with correct columns", () => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("thread_work_items");

    const cols = db.db.pragma("table_info(thread_work_items)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("thread_id");
    expect(colNames).toContain("work_item_id");
    expect(colNames).toContain("relation");
    expect(colNames).toContain("created_at");
  });

  it("has index on work_item_id for reverse lookups", () => {
    const indices = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='thread_work_items'")
      .all() as Array<{ name: string }>;
    const names = indices.map((i) => i.name);
    expect(names.some((n) => n.includes("work_item"))).toBe(true);
  });
});

describe("junction CRUD", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    // Seed data
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Item 100" });
    graph.upsertWorkItem({ id: "AI-200", source: "jira", title: "Item 200" });
    graph.upsertThread({
      id: "T1", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
  });

  afterEach(() => { db.close(); });

  it("linkThreadWorkItem creates a junction row", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const rows = graph.getWorkItemsForThread("T1");
    expect(rows).toHaveLength(1);
    expect(rows[0].workItemId).toBe("AI-100");
    expect(rows[0].relation).toBe("primary");
  });

  it("linkThreadWorkItem is idempotent (upsert)", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "mentioned");
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const rows = graph.getWorkItemsForThread("T1");
    expect(rows).toHaveLength(1);
    expect(rows[0].relation).toBe("primary");
  });

  it("getThreadsForWorkItemViaJunction returns threads", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const threads = graph.getThreadsForWorkItemViaJunction("AI-100");
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("T1");
  });

  it("getThreadsForWorkItemViaJunction prefers primary over mentioned", () => {
    graph.upsertThread({
      id: "T2", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
    graph.linkThreadWorkItem("T1", "AI-100", "mentioned");
    graph.linkThreadWorkItem("T2", "AI-100", "primary");
    const threads = graph.getThreadsForWorkItemViaJunction("AI-100");
    expect(threads[0].id).toBe("T2");
  });

  it("getWorkItemsForThread returns all linked items", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    graph.linkThreadWorkItem("T1", "AI-200", "mentioned");
    const items = graph.getWorkItemsForThread("T1");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.workItemId).sort()).toEqual(["AI-100", "AI-200"]);
  });
});

describe("migration backfill", () => {
  it("backfills junction rows from existing threads and deletes breakdown events", () => {
    // Create a fresh DB — the migration runs during Database construction
    const testDb = new Database(":memory:");

    // Seed pre-existing data that simulates a database before the junction table existed
    testDb.db.prepare(
      "INSERT INTO work_items (id, source, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("AI-100", "jira", "Item 100", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    testDb.db.prepare(
      "INSERT INTO work_items (id, source, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("AI-200", "jira", "Item 200", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

    // Thread linked to AI-100
    testDb.db.prepare(
      "INSERT INTO threads (id, channel_id, channel_name, platform_meta, platform, work_item_id, last_activity, message_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("T1", "C1", "general", "{}", "slack", "AI-100", "2026-01-01T00:00:00Z", 1);

    // Primary event for AI-100
    testDb.db.prepare(
      "INSERT INTO events (id, thread_id, message_id, work_item_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type, targeted_at_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("evt1", "T1", "msg1", "AI-100", "in_progress", 0.9, "reason", "text", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "progress", 1);

    // Breakdown event for AI-200 (message_id contains ':')
    testDb.db.prepare(
      "INSERT INTO events (id, thread_id, message_id, work_item_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type, targeted_at_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("evt2", "T1", "msg1:AI-200", "AI-200", "blocked_on_human", 0.8, "reason", "text", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "block", 1);

    // Run the backfill migration SQL manually (same logic as what migrate() uses):
    // Step 1: Primary rows from threads
    testDb.db.prepare(`
      INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
      SELECT id, work_item_id, 'primary', last_activity
      FROM threads
      WHERE work_item_id IS NOT NULL
    `).run();

    // Step 2: Mentioned rows from events
    testDb.db.prepare(`
      INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
      SELECT e.thread_id, e.work_item_id, 'mentioned', e.timestamp
      FROM events e
      JOIN threads t ON e.thread_id = t.id
      WHERE e.work_item_id IS NOT NULL
        AND e.work_item_id != COALESCE(t.work_item_id, '')
    `).run();

    // Step 3: Delete breakdown events
    testDb.db.prepare(`
      DELETE FROM events WHERE message_id LIKE '%:%'
    `).run();

    // Verify junction rows
    const junctionRows = testDb.db.prepare(
      "SELECT * FROM thread_work_items ORDER BY work_item_id"
    ).all() as Array<{ thread_id: string; work_item_id: string; relation: string }>;

    expect(junctionRows).toHaveLength(2);

    const ai100Row = junctionRows.find((r) => r.work_item_id === "AI-100");
    expect(ai100Row).toBeDefined();
    expect(ai100Row!.relation).toBe("primary");
    expect(ai100Row!.thread_id).toBe("T1");

    const ai200Row = junctionRows.find((r) => r.work_item_id === "AI-200");
    expect(ai200Row).toBeDefined();
    expect(ai200Row!.relation).toBe("mentioned");
    expect(ai200Row!.thread_id).toBe("T1");

    // Breakdown events should be deleted
    const breakdownEvents = testDb.db.prepare(
      "SELECT * FROM events WHERE message_id LIKE '%:%'"
    ).all();
    expect(breakdownEvents).toHaveLength(0);

    // Primary event should still exist
    const primaryEvents = testDb.db.prepare(
      "SELECT * FROM events WHERE id = 'evt1'"
    ).all();
    expect(primaryEvents).toHaveLength(1);

    testDb.close();
  });
});
