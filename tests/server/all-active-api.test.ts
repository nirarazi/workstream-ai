import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database) {
  return {
    config: {
      classifier: { provider: { baseUrl: "", model: "", apiKey: "" } },
      lookback: { initialDays: 3, maxThreadsPerPoll: 100 },
      rateLimits: {},
      operator: { name: "Test", role: "", context: "" },
    },
    db,
    graph,
    classifier: { classify: vi.fn() },
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    messagingRegistry: { getAdapter: () => null },
    taskAdapterRegistry: { getAdapter: () => null },
    operatorIdentities: new Map(),
    startedAt: new Date(),
    services: {},
  } as any;
}

describe("GET /api/stream/all-active", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedItem(id: string, status: string, targeted: boolean) {
    graph.upsertAgent({ id: "agent-1", name: "Relay", platform: "slack", platformUserId: "U001" });
    graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: status as any });
    graph.upsertThread({ id: `T-${id}`, channelId: "C001", channelName: "general", platform: "slack", workItemId: id });
    graph.insertEvent({
      threadId: `T-${id}`, messageId: `msg-${id}`, workItemId: id,
      agentId: "agent-1", status: status as any, confidence: 0.9,
      reason: "test", rawText: "test", timestamp: new Date().toISOString(),
      entryType: "progress", targetedAtOperator: targeted,
    });
  }

  it("returns all non-completed, non-noise items regardless of targetedAtOperator", async () => {
    seedItem("OPS-1", "blocked_on_human", true);
    seedItem("OPS-2", "in_progress", false);
    seedItem("OPS-3", "completed", false);
    seedItem("OPS-4", "noise", false);
    seedItem("OPS-5", "needs_decision", true);

    const state = makeState(graph, db);
    const app = createApp(state);
    const res = await app.request("/api/stream/all-active");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3); // OPS-1, OPS-2, OPS-5 (not completed, not noise)
    const ids = body.items.map((i: any) => i.workItem.id);
    expect(ids).toContain("OPS-1");
    expect(ids).toContain("OPS-2");
    expect(ids).toContain("OPS-5");
    expect(ids).not.toContain("OPS-3");
    expect(ids).not.toContain("OPS-4");
  });

  it("includes pinned field on items", async () => {
    seedItem("OPS-1", "in_progress", false);
    graph.togglePin("OPS-1");

    const state = makeState(graph, db);
    const app = createApp(state);
    const res = await app.request("/api/stream/all-active");

    const body = await res.json();
    expect(body.items[0].workItem.pinned).toBe(true);
  });
});
