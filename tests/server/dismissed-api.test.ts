import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

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

describe("dismissed items and expiry", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "agent-1", name: "Byte", platform: "slack", platformUserId: "U001" });
  });

  afterEach(() => {
    db.close();
  });

  function seed(id: string, status: string, lastMessageAt: string) {
    graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: status as any });
    graph.upsertThread({ id: `T-${id}`, channelId: "C001", channelName: "general", platform: "slack", workItemId: id });
    message(id, lastMessageAt);
  }
  let n = 0;
  function message(id: string, at: string) {
    graph.insertEvent({
      threadId: `T-${id}`, messageId: `msg-${id}-${n++}`, workItemId: id, agentId: "agent-1",
      status: "blocked_on_human", confidence: 0.9, reason: "needs you", rawText: "please look", timestamp: at,
      entryType: "block", targetedAtOperator: true,
    });
  }
  const inboxIds = () => graph.getActionableItems().map((i) => i.workItem.id);
  const dismissedIds = () => graph.getDismissedItems().map((i) => i.workItem.id);

  it("auto-dismisses Needs-me items with no message for N days, as expired", () => {
    seed("OLD", "blocked_on_human", daysAgo(20));
    seed("RECENT", "needs_decision", daysAgo(2));
    seed("WORKING", "in_progress", daysAgo(20));

    expect(graph.expireInactiveItems(14, NOW)).toBe(1);

    expect(graph.getWorkItemById("OLD")!.dismissReason).toBe("expired");
    expect(inboxIds()).toEqual(["RECENT"]);
    expect(dismissedIds()).toEqual(["OLD"]);
    expect(graph.getWorkItemById("WORKING")!.dismissedAt).toBeNull();
  });

  it("leaves pinned and currently snoozed items alone", () => {
    seed("PINNED", "blocked_on_human", daysAgo(20));
    graph.togglePin("PINNED");
    seed("SNOOZED", "blocked_on_human", daysAgo(20));
    db.db.prepare("UPDATE work_items SET snoozed_until = ? WHERE id = 'SNOOZED'").run(daysAgo(-3));

    expect(graph.expireInactiveItems(14, NOW)).toBe(0);
  });

  it("keeps an operator dismissal as 'operator' — it is never re-labelled expired", () => {
    seed("MINE", "blocked_on_human", daysAgo(20));
    graph.dismissWorkItem("MINE");
    // The dismiss endpoint also records a (non-targeted) event right after
    graph.insertEvent({
      threadId: "T-MINE", messageId: "operator-dismiss", workItemId: "MINE", agentId: null,
      status: "blocked_on_human", confidence: 1, reason: "Operator dismissed from stream", rawText: null,
      timestamp: new Date().toISOString(), entryType: "decision", targetedAtOperator: false,
    });

    graph.expireInactiveItems(1, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    expect(graph.getWorkItemById("MINE")!.dismissReason).toBe("operator");
  });

  it("brings an expired item back when a new message is aimed at the operator", () => {
    seed("BACK", "blocked_on_human", daysAgo(20));
    graph.expireInactiveItems(14, NOW);
    expect(inboxIds()).toEqual([]);

    message("BACK", new Date(Date.now() + 60_000).toISOString());

    expect(inboxIds()).toEqual(["BACK"]);
    expect(dismissedIds()).toEqual([]);
  });

  it("GET /api/stream/dismissed lists dismissed items, newest dismissal first, with the reason", async () => {
    seed("A", "blocked_on_human", daysAgo(20));
    seed("B", "blocked_on_human", daysAgo(1));
    graph.expireInactiveItems(14, NOW);
    graph.dismissWorkItem("B");

    const res = await createApp(makeState(graph, db)).request("/api/stream/dismissed");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => [i.workItem.id, i.workItem.dismissReason])).toEqual([
      ["B", "operator"],
      ["A", "expired"],
    ]);
    expect(body.items[0].latestEvent.rawText).toBe("please look");
  });
});
