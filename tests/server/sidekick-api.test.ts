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
      slack: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", apiKey: "test" }, confidenceThreshold: 0.6 },
      jira: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      sidekick: { enabled: true, maxToolCalls: 5, maxHistoryTurns: 10 },
    } as any,
    db,
    graph,
    classifier,
    linker,
    pipeline: null,
    platformAdapter: null,
    taskAdapter: null,
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
    summarizer: null,
  } as any;
}

describe("POST /api/sidekick", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns an answer for a valid question", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // LLM returns a direct text answer (no tool use)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "There is 1 work item in progress." }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      ),
    );

    const app = createApp(state);
    const res = await app.request("/api/sidekick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How many items are active?", history: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toContain("1 work item");

    fetchSpy.mockRestore();
  });

  it("returns 400 for missing question", async () => {
    const app = createApp(state);
    const res = await app.request("/api/sidekick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: [] }),
    });

    expect(res.status).toBe(400);
  });
});
