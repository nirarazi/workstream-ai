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
