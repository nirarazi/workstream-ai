import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifier = new Classifier(
    { name: "mock", classify: vi.fn() },
    "sys",
    [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] }),
  ]);
  return {
    config: {
      messaging: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test", apiKey: "" }, confidenceThreshold: 0.6 },
      taskAdapter: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      quickReplies: {
        blocked_on_human: ["Approved, proceed", "Hold"],
        needs_decision: ["Option A", "Option B"],
      },
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
    ...overrides,
  };
}

describe("GET /api/work-item/:id/context", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    // Set up test data
    state.graph.upsertAgent({
      id: "a1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U1",
    });
    state.graph.upsertWorkItem({
      id: "AI-382",
      source: "jira",
      title: "Fix login bug",
      currentAtcStatus: "blocked_on_human",
      currentConfidence: 0.95,
    });
    state.graph.upsertThread({
      id: "t1",
      channelId: "C123",
      channelName: "agent-orchestrator",
      platform: "slack",
      workItemId: "AI-382",
      messageCount: 3,
    });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-382",
      agentId: "a1",
      status: "in_progress",
      confidence: 0.9,
      reason: "Agent started work",
      rawText: "Starting work on AI-382",
      timestamp: "2026-03-31T08:00:00Z",
    });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m2",
      workItemId: "AI-382",
      agentId: "a1",
      status: "blocked_on_human",
      confidence: 0.95,
      reason: "Needs approval",
      rawText: "PR ready, need approval",
      timestamp: "2026-03-31T10:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns context with events, enrichments, and quick replies", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/context");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.workItem.id).toBe("AI-382");
    expect(body.events).toHaveLength(2);
    expect(body.events[0].rawText).toBe("Starting work on AI-382");
    expect(body.threads).toHaveLength(1);
    expect(body.quickReplies).toBeInstanceOf(Array);
    expect(body.quickReplies.length).toBeGreaterThan(0);
  });

  it("returns 404 for non-existent work item", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/NOPE-1/context");
    expect(res.status).toBe(404);
  });

  it("includes enrichments when available", async () => {
    state.graph.upsertEnrichment({
      workItemId: "AI-382",
      source: "jira",
      data: { status: "In Review", description: "Fix the login redirect bug" },
    });

    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/context");
    const body = await res.json();

    expect(body.enrichments).toHaveLength(1);
    expect(body.enrichments[0].data.status).toBe("In Review");
  });
});

describe("POST /api/work-item/:id/summarize", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-382", source: "jira", title: "Fix login", currentAtcStatus: "blocked_on_human" });
    state.graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-382" });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-382",
      agentId: "a1",
      status: "blocked_on_human",
      confidence: 0.95,
      rawText: "Need approval for PR",
      timestamp: "2026-03-31T10:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("generates and caches a summary", async () => {
    // Override config to use Anthropic URL so the Summarizer takes the Anthropic path
    state.config.classifier.provider.baseUrl = "https://api.anthropic.com/v1";
    state.config.classifier.provider.apiKey = "test-key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ text: "- PR needs approval\n- Agent blocked" }] }),
        { status: 200 },
      ),
    );

    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/summarize", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("PR needs approval");

    // Verify it was cached
    const cached = state.graph.getSummary("AI-382");
    expect(cached).not.toBeNull();
    expect(cached!.summaryText).toContain("PR needs approval");

    fetchSpy.mockRestore();
  });

  it("returns 404 for non-existent work item", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/NOPE-1/summarize", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
