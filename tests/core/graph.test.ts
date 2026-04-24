// tests/core/graph.test.ts — Tests for graph schema and merged_into support

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("merged_into column", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("work_items table has merged_into column", () => {
    const cols = db.db.pragma("table_info(work_items)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "merged_into")).toBe(true);
  });

  it("work items have a mergedInto field defaulting to null", () => {
    const wi = graph.upsertWorkItem({
      id: "AI-1",
      source: "jira",
      title: "Test item",
    });

    expect(wi.mergedInto).toBeNull();
  });

  it("getWorkItemById returns mergedInto as null by default", () => {
    graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Another item" });

    const fetched = graph.getWorkItemById("AI-2");
    expect(fetched).not.toBeNull();
    expect(fetched!.mergedInto).toBeNull();
  });
});
