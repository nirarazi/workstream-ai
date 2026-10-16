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
      server: { port: 9847, host: "127.0.0.1" },
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
      id: "OPS-200",
      source: "jira",
      title: "Test item",
      currentAtcStatus: "blocked_on_human",
    });
    graph.upsertThread({
      id: "T001",
      channelId: "C001",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-200",
    });
    graph.upsertAgent({
      id: "agent-1",
      name: "Relay",
      platform: "slack",
      platformUserId: "U001",
    });
    graph.insertEvent({
      threadId: "T001",
      messageId: "msg-1",
      workItemId: "OPS-200",
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
      body: JSON.stringify({ workItemId: "OPS-200", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("OPS-200");
    expect(wi?.dismissedAt).not.toBeNull();
    expect(wi?.currentAtcStatus).toBe("blocked_on_human"); // status unchanged
  });

  it("close clears the reopened mark and records when it was closed", async () => {
    graph.setReopened("OPS-200", "2026-10-15T09:00:00.000Z");
    const app = createApp(makeState(graph, db));
    const before = new Date().toISOString();

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "close" }),
    });

    expect(res.status).toBe(200);
    const wi = graph.getWorkItemById("OPS-200")!;
    expect(wi.currentAtcStatus).toBe("completed");
    expect(wi.reopenedAt).toBeNull();
    expect(wi.statusAt! >= before).toBe(true); // a message posted before now can't reopen it
  });

  it("noise action reclassifies work item as noise", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "noise" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("OPS-200");
    expect(wi?.currentAtcStatus).toBe("noise");
  });

  it("action with message returns delivered: true on success", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workItemId: "OPS-200",
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
      body: JSON.stringify({ workItemId: "OPS-200", action: "redirect" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delivered).toBe(false);
  });

  it("dismiss succeeds when thread is linked via junction table only (not threads.work_item_id)", async () => {
    // Create a second work item (OPS-200-JT) with no directly linked thread
    graph.upsertWorkItem({
      id: "OPS-200-JT",
      source: "jira",
      title: "Junction-only item",
      currentAtcStatus: "blocked_on_human",
    });

    // Create a thread T-JT linked to OPS-100 via work_item_id (not to OPS-200-JT)
    graph.upsertWorkItem({
      id: "OPS-100",
      source: "jira",
      title: "Primary item",
      currentAtcStatus: "in_progress",
    });
    graph.upsertThread({
      id: "T-JT",
      channelId: "C002",
      channelName: "dev",
      platform: "slack",
      workItemId: "OPS-100",
    });

    // Link T-JT → OPS-200-JT via junction table only (relation: 'mentioned')
    graph.linkThreadWorkItem("T-JT", "OPS-200-JT", "mentioned");

    const state = makeState(graph, db);
    const app = createApp(state);

    // Perform a dismiss action on OPS-200-JT
    // The handler must find T-JT via the junction table, not via threads.work_item_id
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200-JT", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The work item should be dismissed
    const wi = graph.getWorkItemById("OPS-200-JT");
    expect(wi?.dismissedAt).not.toBeNull();
  });
});

describe("the operator's message is logged once", () => {
  const POSTED = { messageId: "1791000000.000100", timestamp: "2026-10-14T04:09:20.000Z" };
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertWorkItem({ id: "OPS-200", source: "jira", title: "Test item", currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T001", channelId: "C001", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-200" });
    graph.linkThreadWorkItem("T001", "OPS-200", "primary");
  });

  afterEach(() => db.close());

  const eventsFor = (messageId: string) =>
    db.db.prepare("SELECT reason, timestamp FROM events WHERE message_id = ?").all(messageId) as Array<{ reason: string; timestamp: string }>;

  it("records an action under the posted message, so reading it back adds nothing", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue(POSTED);

    const res = await createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "redirect", message: "What is the decision needed from me?" }),
    });
    expect(res.status).toBe(200);
    expect(eventsFor(POSTED.messageId)).toEqual([{ reason: "Operator unblocked", timestamp: POSTED.timestamp }]);

    // The pipeline then reads the same message back from the platform
    const classify = vi.fn();
    const message = {
      id: POSTED.messageId, threadId: "T001", channelId: "C001", channelName: "fleet-ops", userId: "U0OPERATOR1", userName: "Alex",
      text: "What is the decision needed from me?", timestamp: POSTED.timestamp, platform: "slack",
    };
    const adapter = {
      name: "fake",
      readThreads: vi.fn(async () => [{ id: "T001", channelId: "C001", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
      getThreadMessages: vi.fn(async () => []),
    } as any;
    const { Pipeline } = await import("../../core/pipeline.js");
    const { WorkItemLinker } = await import("../../core/graph/linker.js");
    const pipeline = new Pipeline(adapter, { classify } as any, graph, new WorkItemLinker(graph, []), undefined, {
      messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 },
    } as any);
    await pipeline.processOnce();

    expect(classify).not.toHaveBeenCalled();
    expect(eventsFor(POSTED.messageId)).toHaveLength(1);
  });

  it("records a reply under the posted message", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue(POSTED);

    const res = await createApp(state).request("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "T001", channelId: "C001", message: "Thanks", workItemId: "OPS-200" }),
    });

    expect(res.status).toBe(200);
    expect(eventsFor(POSTED.messageId)).toEqual([{ reason: "Operator reply", timestamp: POSTED.timestamp }]);
  });

  it("still records the action when its message fails to post", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockRejectedValue(new Error("Slack is down"));

    const res = await createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "approve", message: "Ship it" }),
    });

    expect(res.status).toBe(500);
    const rows = db.db.prepare("SELECT message_id, reason FROM events WHERE reason = 'Operator approved'").all() as Array<{ message_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].message_id).toMatch(/^operator-action-/);
  });
});

