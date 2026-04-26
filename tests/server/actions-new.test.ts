import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database) {
  const messagingAdapter = {
    name: "mock",
    displayName: "Mock",
    connect: vi.fn(),
    disconnect: vi.fn(),
    getChannels: vi.fn().mockResolvedValue([]),
    getThreadMessages: vi.fn().mockResolvedValue([]),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    getAuthenticatedUser: vi.fn().mockResolvedValue({ userId: "U_OP", userName: "Operator" }),
    fetchUsers: vi.fn().mockResolvedValue(new Map()),
    buildThread: vi.fn(),
    forwardMessage: vi.fn(),
  };

  return {
    config: {
      classifier: { provider: { baseUrl: "", model: "", apiKey: "" } },
      lookback: { initialDays: 3, maxThreadsPerPoll: 100 },
      rateLimits: {},
      operator: { name: "Test", role: "", context: "" },
    },
    db,
    graph,
    classifier: { classify: vi.fn(), getBackoffState: vi.fn().mockReturnValue(null) },
    usageTracker: null,
    linker: { processThread: vi.fn() },
    pipeline: null,
    messagingAdapter,
    taskAdapter: null,
    rateLimiters: {},
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
    operatorIdentities: new Map(),
  } as any;
}

describe("dismiss and noise actions", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertWorkItem({
      id: "AI-200",
      source: "jira",
      title: "Test item",
      currentAtcStatus: "blocked_on_human",
    });
    graph.upsertThread({
      id: "T001",
      channelId: "C001",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-200",
    });
    graph.upsertAgent({
      id: "agent-1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U001",
    });
    graph.insertEvent({
      threadId: "T001",
      messageId: "msg-1",
      workItemId: "AI-200",
      agentId: "agent-1",
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "blocked",
      rawText: "Need help",
      timestamp: new Date().toISOString(),
      entryType: "block",
      targetedAtOperator: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("dismiss action sets dismissed_at without changing status", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("AI-200");
    expect(wi?.dismissedAt).not.toBeNull();
    expect(wi?.currentAtcStatus).toBe("blocked_on_human"); // status unchanged
  });

  it("noise action reclassifies work item as noise", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "noise" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("AI-200");
    expect(wi?.currentAtcStatus).toBe("noise");
  });

  it("action with message returns delivered: true on success", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workItemId: "AI-200",
        action: "redirect",
        message: "Done, try again",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(true);
  });

  it("action without message returns delivered: false", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "redirect" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delivered).toBe(false);
  });

  it("dismiss succeeds when thread is linked via junction table only (not threads.work_item_id)", async () => {
    // Create a second work item (AI-200-JT) with no directly linked thread
    graph.upsertWorkItem({
      id: "AI-200-JT",
      source: "jira",
      title: "Junction-only item",
      currentAtcStatus: "blocked_on_human",
    });

    // Create a thread T-JT linked to AI-100 via work_item_id (not to AI-200-JT)
    graph.upsertWorkItem({
      id: "AI-100",
      source: "jira",
      title: "Primary item",
      currentAtcStatus: "in_progress",
    });
    graph.upsertThread({
      id: "T-JT",
      channelId: "C002",
      channelName: "dev",
      platform: "slack",
      workItemId: "AI-100",
    });

    // Link T-JT → AI-200-JT via junction table only (relation: 'mentioned')
    graph.linkThreadWorkItem("T-JT", "AI-200-JT", "mentioned");

    const state = makeState(graph, db);
    const app = createApp(state);

    // Perform a dismiss action on AI-200-JT
    // The handler must find T-JT via the junction table, not via threads.work_item_id
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200-JT", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The work item should be dismissed
    const wi = graph.getWorkItemById("AI-200-JT");
    expect(wi?.dismissedAt).not.toBeNull();
  });
});
