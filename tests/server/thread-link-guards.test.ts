// tests/server/thread-link-guards.test.ts — manual thread links, against the real routes and graph

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database) {
  return {
    config: { server: { port: 9847, host: "127.0.0.1" } },
    db, graph,
    classifier: { classify: vi.fn() },
    pipeline: null, messagingAdapter: null, taskAdapter: null,
    operatorIdentities: new Map(), startedAt: new Date(),
  } as any;
}

describe("manual thread links", () => {
  let db: Database;
  let graph: ContextGraph;
  const post = (path: string, threadId: string) => createApp(makeState(graph, db)).request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId }),
  });

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    for (const id of ["OPS-1", "OPS-5"]) graph.upsertWorkItem({ id, source: "jira", title: id });
    graph.upsertThread({ id: "T-1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-1", "OPS-1", "primary");
  });
  afterEach(() => db.close());

  it("links a thread to an item, making it the item's own", async () => {
    expect((await post("/api/work-item/OPS-5/link-thread", "T-1")).status).toBe(200);
    expect(graph.getThreadById("T-1")!.workItemId).toBe("OPS-5");
    expect(db.db.prepare("SELECT work_item_id, relation FROM thread_work_items ORDER BY work_item_id").all()).toEqual([
      { work_item_id: "OPS-1", relation: "mentioned" },
      { work_item_id: "OPS-5", relation: "primary" },
    ]);
  });

  it("says a thread the engine doesn't have isn't found", async () => {
    expect((await post("/api/work-item/OPS-5/link-thread", "T-UNKNOWN")).status).toBe(404);
  });

  it("unlinks a thread only from the item it belongs to", async () => {
    expect((await post("/api/work-item/OPS-5/unlink-thread", "T-1")).status).toBe(404);
    expect(graph.getThreadById("T-1")!.workItemId).toBe("OPS-1");

    expect((await post("/api/work-item/OPS-1/unlink-thread", "T-1")).status).toBe(200);
    expect(graph.getThreadById("T-1")!.workItemId).toBeNull();
  });
});
