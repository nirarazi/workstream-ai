import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

function makeState(): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifier = new Classifier(
    { name: "mock", classify: vi.fn() },
    "sys",
    [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: [], prPatterns: [] }),
  ]);
  return {
    config: {
      messaging: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
      taskAdapter: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      anomalies: { staleThresholdHours: 4, silentAgentThresholdHours: 2 },
    } as any,
    db,
    graph,
    classifier,
    linker,
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    rateLimiters: {},
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
    summarizer: null,
  } as any;
}

describe("GET /api/fleet", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Active", currentAtcStatus: "in_progress" });
    state.graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Done", currentAtcStatus: "completed" });

    state.graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    state.graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });

    state.graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-1", agentId: "a1",
      status: "in_progress", confidence: 0.9, timestamp: "2026-04-01T08:00:00Z",
    });
    state.graph.insertEvent({
      threadId: "t2", messageId: "m2", workItemId: "AI-2", agentId: "a1",
      status: "completed", confidence: 0.95, timestamp: "2026-04-01T09:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns non-completed items with anomaly flags", async () => {
    const app = createApp(state);
    const res = await app.request("/api/fleet");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].workItem.id).toBe("AI-1");
    expect(body.items[0].anomalies).toBeInstanceOf(Array);
  });
});
