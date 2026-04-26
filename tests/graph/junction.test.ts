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
