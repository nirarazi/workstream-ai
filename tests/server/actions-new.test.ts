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

  it("refuses an action on an item merged since it was shown, and leaves the item it went into alone", async () => {
    graph.upsertWorkItem({ id: "OPS-201", source: "jira", currentAtcStatus: "blocked_on_human" });
    graph.mergeWorkItems("OPS-201", "OPS-200");
    const app = createApp(makeState(graph, db));

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-201", action: "close" }),
    });

    expect(res.status).toBe(409);
    expect(graph.getWorkItemById("OPS-200")!.currentAtcStatus).toBe("blocked_on_human");
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

  for (const action of ["dismiss", "noise"] as const) {
    it(`records ${action} with its message under the posted message`, async () => {
      const state = makeState(graph, db);
      state.messagingAdapter.replyToThread.mockResolvedValue(POSTED);

      const res = await createApp(state).request("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId: "OPS-200", action, message: "Not for me" }),
      });

      expect(res.status).toBe(200);
      expect(eventsFor(POSTED.messageId)).toEqual([{
        reason: action === "dismiss" ? "Operator dismissed from stream" : "Operator classified as noise",
        timestamp: POSTED.timestamp,
      }]);
    });
  }

  it("keeps the thread in the late-reply window when the operator posts in an old thread", async () => {
    const old = new Date(Date.now() - 2.5 * 24 * 60 * 60 * 1000).toISOString();
    graph.upsertThread({ id: "T001", channelId: "C001", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-200", lastActivity: old });
    const now = new Date().toISOString();
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue({ messageId: "1791000000.000300", timestamp: now });

    await createApp(state).request("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "T001", channelId: "C001", message: "Any news?", workItemId: "OPS-200" }),
    });

    expect(graph.getThreadById("T001")!.lastActivity).toBe(now);
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(graph.getKnownThreads(windowStart).has("T001")).toBe(true);
  });

  it("reports success once the message went out, even if recording it fails", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue(POSTED);
    const insert = vi.spyOn(graph, "insertEvent").mockImplementation(() => { throw new Error("database is locked"); });

    const res = await createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "approve", message: "Ship it" }),
    });

    insert.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, delivered: true });
  });

  it("reports a reply as sent once it went out, even if recording it fails", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue(POSTED);
    const insert = vi.spyOn(graph, "insertEvent").mockImplementation(() => { throw new Error("database is locked"); });

    const res = await createApp(state).request("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "T001", channelId: "C001", message: "Thanks", workItemId: "OPS-200" }),
    });

    insert.mockRestore();
    expect(res.status).toBe(200);
  });

  it("stores an adapter's posted time as ISO", async () => {
    const state = makeState(graph, db);
    // A minute ahead, so it's later than the thread's last activity whenever the test runs
    const later = new Date(Math.ceil((Date.now() + 60_000) / 1000) * 1000);
    state.messagingAdapter.replyToThread.mockResolvedValue({ messageId: "1791000000.000400", timestamp: later.toUTCString() });

    await createApp(state).request("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "T001", channelId: "C001", message: "Thanks", workItemId: "OPS-200" }),
    });

    expect(eventsFor("1791000000.000400")[0].timestamp).toBe(later.toISOString());
    expect(graph.getThreadById("T001")!.lastActivity).toBe(later.toISOString());
  });

  it("ignores a blank message ID from the adapter, so actions don't collide", async () => {
    const state = makeState(graph, db);
    state.messagingAdapter.replyToThread.mockResolvedValue({ messageId: "", timestamp: POSTED.timestamp });
    const act = (message: string) => createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-200", action: "redirect", message }),
    });

    await act("first");
    await new Promise((r) => setTimeout(r, 2));
    await act("second");

    const rows = db.db.prepare("SELECT message_id, raw_text FROM events WHERE reason = 'Operator unblocked' ORDER BY raw_text").all() as Array<{ message_id: string; raw_text: string }>;
    expect(rows.map((r) => r.raw_text)).toEqual(["first", "second"]);
    for (const r of rows) expect(r.message_id).toMatch(/^operator-action-/);
  });

  it("dismisses an item with no thread instead of failing", async () => {
    graph.upsertWorkItem({ id: "OPS-300", source: "jira", title: "No conversation yet", currentAtcStatus: "blocked_on_human" });
    const state = makeState(graph, db);

    const res = await createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-300", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    expect(graph.getWorkItemById("OPS-300")!.dismissedAt).not.toBeNull();
  });

  it("says there's no thread to post to, without posting, but keeps the action", async () => {
    graph.upsertWorkItem({ id: "OPS-301", source: "jira", title: "No conversation yet", currentAtcStatus: "blocked_on_human" });
    const state = makeState(graph, db);

    const res = await createApp(state).request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "OPS-301", action: "close", message: "Closing this" }),
    });

    expect(res.status).toBe(404);
    expect(state.messagingAdapter.replyToThread).not.toHaveBeenCalled();
    expect(graph.getWorkItemById("OPS-301")!.currentAtcStatus).toBe("completed");
  });

  for (const action of ["redirect", "noise"] as const) {
    it(`${action} records when the operator acted, so an earlier message or digest can't undo it`, async () => {
      graph.upsertWorkItem({ id: "OPS-200", source: "jira", statusAt: "2026-10-01T00:00:00.000Z" });
      const before = Date.now();

      await createApp(makeState(graph, db)).request("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId: "OPS-200", action }),
      });

      expect(Date.parse(graph.getWorkItemById("OPS-200")!.statusAt!)).toBeGreaterThanOrEqual(before);
    });
  }

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

