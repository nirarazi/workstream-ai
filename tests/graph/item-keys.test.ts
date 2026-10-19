// tests/graph/item-keys.test.ts — the keys that name a work item, and how merges and the backfill keep them

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { keyKind, legacyKeyOf } from "../../core/graph/item-keys.js";

describe("legacyKeyOf", () => {
  it("keys a ticket id, a thread id and an id an agent passed", () => {
    expect(legacyKeyOf("OPS-101", "jira")).toBe("ticket:OPS-101");
    expect(legacyKeyOf("ops-101", "extracted")).toBe("ticket:OPS-101");
    expect(legacyKeyOf("thread:1700000000.000100", "inferred")).toBe("thread:1700000000.000100");
    expect(legacyKeyOf("OPS-101", "mcp")).toBe("ticket:OPS-101");
    expect(legacyKeyOf("northwind-export", "mcp")).toBe("mcp:northwind-export");
  });

  it("gives no key to an id that names nothing a key can", () => {
    expect(legacyKeyOf("Northwind deck", "inferred")).toBeNull();
    expect(legacyKeyOf("UTF-8", "inferred")).toBeNull();
    expect(legacyKeyOf("thread:", "inferred")).toBeNull();
    expect(keyKind("ticket:OPS-101")).toBe("ticket");
    expect(keyKind("subject:partner:northwind")).toBeNull();
  });
});

describe("item keys in the graph", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => db.close());

  it("gives a new item the key its id is, once", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Export" });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Export, renamed" });
    graph.upsertWorkItem({ id: "Northwind deck", source: "inferred" });
    expect(graph.getItemKeys("OPS-101").map((k) => [k.key, k.decidedBy])).toEqual([["ticket:OPS-101", "engine"]]);
    expect(graph.findItemByKey("ticket:OPS-101")).toBe("OPS-101");
    expect(graph.getItemKeys("Northwind deck")).toEqual([]);
  });

  it("moves the source's keys to the target on merge, and gives them back on unmerge", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    graph.mergeWorkItems("thread:T1", "OPS-101");

    expect(graph.findItemByKey("thread:T1")).toBe("OPS-101");
    expect(graph.getItemKeys("OPS-101").map((k) => k.key).sort()).toEqual(["thread:T1", "ticket:OPS-101"]);
    expect(graph.getItemKeys("thread:T1")).toEqual([]);
    // Retired, not deleted
    expect(graph.getItemKeys("thread:T1", { all: true })).toEqual([expect.objectContaining({ key: "thread:T1" })]);

    graph.unmergeWorkItem("thread:T1");
    expect(graph.findItemByKey("thread:T1")).toBe("thread:T1");
    expect(graph.findItemByKey("ticket:OPS-101")).toBe("OPS-101");
    expect(graph.getItemKeys("OPS-101").map((k) => k.key)).toEqual(["ticket:OPS-101"]);
    // Back as the item's own, as it held it before
    expect(graph.getItemKeys("thread:T1").map((k) => k.decidedBy)).toEqual(["engine"]);
  });

  it("hands keys back down a merge chain as the merges are undone", () => {
    for (const id of ["OPS-1", "OPS-2", "OPS-3"]) graph.upsertWorkItem({ id, source: "jira" });
    graph.mergeWorkItems("OPS-1", "OPS-2");
    graph.mergeWorkItems("OPS-2", "OPS-3");
    expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-3");
    graph.unmergeWorkItem("OPS-2");
    expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-2");
    graph.unmergeWorkItem("OPS-1");
    expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-1");
    expect(graph.findItemByKey("ticket:OPS-2")).toBe("OPS-2");
    expect(graph.ownTicketKey("OPS-1")).toBe("OPS-1");
  });

  it("asks the tracker about an item by its own ticket key, not one merged into it", () => {
    graph.upsertWorkItem({ id: "OPS-7", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-9", source: "jira" });
    graph.mergeWorkItems("OPS-7", "OPS-9");
    expect(graph.ownTicketKey("OPS-9")).toBe("OPS-9");
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    graph.mergeWorkItems("OPS-9", "thread:T1");
    // A conversation with no ticket of its own: the first one merged into it
    expect(["OPS-9", "OPS-7"]).toContain(graph.ownTicketKey("thread:T1"));
  });

  it("stores the item's ticket key with an enrichment", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertEnrichment({ workItemId: "OPS-101", source: "jira", data: { status: "In Progress" } });
    const row = db.db.prepare("SELECT key FROM enrichments WHERE work_item_id = 'OPS-101'").get() as { key: string };
    expect(row.key).toBe("ticket:OPS-101");
  });
});

describe("the item key backfill", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "item-keys-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keys the items a database held before keys existed, a merged item's key going to its live item", () => {
    const path = join(dir, "workstream.db");
    // A database from before item_keys and enrichments.key
    const old = new BetterSqlite3(path);
    old.exec(`
      CREATE TABLE work_items (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        external_status TEXT, assignee TEXT, url TEXT, current_atc_status TEXT, current_confidence REAL,
        snoozed_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_into TEXT DEFAULT NULL);
      CREATE TABLE enrichments (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, source TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', fetched_at TEXT NOT NULL);
      INSERT INTO work_items (id, source, created_at, updated_at, merged_into) VALUES
        ('OPS-101', 'jira', 't0', 't0', NULL),
        ('thread:T1', 'inferred', 't0', 't1', 'OPS-101'),
        ('Northwind deck', 'inferred', 't0', 't0', NULL);
      INSERT INTO enrichments (id, work_item_id, source, data, fetched_at) VALUES ('e1', 'OPS-101', 'jira', '{}', 't0');
    `);
    old.close();

    const db = new Database(path);
    const graph = new ContextGraph(db);
    expect(graph.findItemByKey("ticket:OPS-101")).toBe("OPS-101");
    expect(graph.findItemByKey("thread:T1")).toBe("OPS-101");
    expect(graph.getItemKeys("thread:T1", { all: true })).toEqual([expect.objectContaining({ key: "thread:T1", retiredAt: "t1" })]);
    expect(graph.getItemKeys("Northwind deck")).toEqual([]);
    expect((db.db.prepare("SELECT key FROM enrichments").get() as { key: string }).key).toBe("ticket:OPS-101");

    // Unmerging a merge from before keys gives the key back too
    graph.unmergeWorkItem("thread:T1");
    expect(graph.findItemByKey("thread:T1")).toBe("thread:T1");
    db.close();

    // Running again changes nothing
    const again = new Database(path);
    const count = (again.db.prepare("SELECT COUNT(*) AS n FROM item_keys").get() as { n: number }).n;
    again.close();
    const third = new Database(path);
    expect((third.db.prepare("SELECT COUNT(*) AS n FROM item_keys").get() as { n: number }).n).toBe(count);
    third.close();
  });
});

describe("resolveItemRef", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => db.close());

  it("names the live item: by id, by the key a merge moved, or by an agent's MCP id", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-200", source: "jira" });
    graph.upsertWorkItem({ id: "northwind-export", source: "mcp" });
    expect(graph.resolveItemRef("OPS-101")).toBe("OPS-101");
    expect(graph.resolveItemRef("northwind-export")).toBe("northwind-export");
    expect(graph.resolveItemRef("OPS-999")).toBe("OPS-999");

    graph.mergeWorkItems("OPS-101", "OPS-200");
    expect(graph.resolveItemRef("OPS-101")).toBe("OPS-200");
    expect(graph.resolveItemRef("ops-101")).toBe("OPS-200");
    expect(graph.getWorkItemByRef("OPS-101")!.id).toBe("OPS-200");
    // The operator's actions by id still mean that very item
    expect(graph.getWorkItemById("OPS-101")!.mergedInto).toBe("OPS-200");
  });

  it("sends an update for a merged item's id to the item it was merged into", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-200", source: "jira" });
    graph.mergeWorkItems("OPS-101", "OPS-200");
    graph.upsertWorkItem({ id: "OPS-101", source: "mcp", currentAtcStatus: "blocked_on_human" });
    expect(graph.getWorkItemById("OPS-200")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBeNull();
  });
});

describe("the item key backfill, for a chain of merges", () => {
  it("hands each key back down the chain as the merges are undone", () => {
    const dir = mkdtempSync(join(tmpdir(), "item-keys-chain-"));
    try {
      const path = join(dir, "workstream.db");
      const old = new BetterSqlite3(path);
      old.exec(`
        CREATE TABLE work_items (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
          external_status TEXT, assignee TEXT, url TEXT, current_atc_status TEXT, current_confidence REAL,
          snoozed_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_into TEXT DEFAULT NULL);
        INSERT INTO work_items (id, source, created_at, updated_at, merged_into) VALUES
          ('OPS-1', 'jira', 't0', 't1', 'OPS-2'), ('OPS-2', 'jira', 't0', 't2', 'OPS-3'), ('OPS-3', 'jira', 't0', 't0', NULL);
      `);
      old.close();
      const db = new Database(path);
      const graph = new ContextGraph(db);
      expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-3");
      graph.unmergeWorkItem("OPS-2");
      expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-2");
      graph.unmergeWorkItem("OPS-1");
      expect(graph.findItemByKey("ticket:OPS-1")).toBe("OPS-1");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
