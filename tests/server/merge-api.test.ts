// tests/server/merge-api.test.ts — merging and unmerging work items through the engine's API

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

let db: Database;
let graph: ContextGraph;

function makeState() {
  return {
    config: { server: { port: 9847, host: "127.0.0.1" } },
    db,
    graph,
    classifier: { classify: vi.fn() },
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    operatorIdentities: new Map(),
    startedAt: new Date(),
  } as any;
}

const post = (path: string, body?: unknown) => createApp(makeState()).request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
});
const merge = (sourceId: string, targetId: string) => post(`/api/work-item/${targetId}/merge`, { sourceId });
const unmerge = (sourceId: string) => post(`/api/work-item/${sourceId}/unmerge`);

beforeEach(() => {
  db = new Database(":memory:");
  graph = new ContextGraph(db);
  for (const id of ["OPS-101", "OPS-102", "ENG-202"]) graph.upsertWorkItem({ id, source: "jira", title: id });
});

afterEach(() => db.close());

describe("Merge API", () => {
  it("refuses a second merge of the same item, a chain and a cycle with a 400 that says why", async () => {
    expect((await merge("OPS-101", "ENG-202")).status).toBe(200);

    const again = await merge("OPS-101", "OPS-102");
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already merged into ENG-202/);

    const chain = await merge("OPS-102", "OPS-101");
    expect(chain.status).toBe(400);
    expect((await chain.json()).error).toMatch(/merge into that instead/);

    const cycle = await merge("ENG-202", "OPS-101");
    expect(cycle.status).toBe(400);
    expect(graph.getWorkItemById("ENG-202")!.mergedInto).toBeNull();
  });

  it("refuses to unmerge an item whose target was merged since, with a 400 that says to unmerge that first", async () => {
    await merge("OPS-101", "ENG-202");
    await merge("ENG-202", "OPS-102");

    const res = await unmerge("OPS-101");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unmerge it first/);

    expect((await unmerge("ENG-202")).status).toBe(200);
    expect((await unmerge("OPS-101")).status).toBe(200);
    expect(graph.getWorkItemById("OPS-101")!.mergedInto).toBeNull();
  });
});
