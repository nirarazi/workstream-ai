import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();

function makeState(graph: ContextGraph, db: Database) {
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

describe("Done tab", () => {
  let db: Database;
  let graph: ContextGraph;
  let n = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "agent-1", name: "Relay", platform: "slack", platformUserId: "U001" });
  });

  afterEach(() => db.close());

  function seed(id: string, status: string, finishedMinutesAgo: number) {
    graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: status as any, statusAt: at(finishedMinutesAgo) });
    graph.upsertThread({ id: `T-${id}`, channelId: "C001", channelName: "fleet-ops", platform: "slack", workItemId: id });
    graph.insertEvent({
      threadId: `T-${id}`, messageId: `msg-${n++}`, workItemId: id, agentId: "agent-1",
      status: status as any, confidence: 0.9, reason: "shipped", rawText: "OPS done", timestamp: at(finishedMinutesAgo),
      entryType: "progress", targetedAtOperator: false,
    });
  }

  it("lists completed items, most recently finished first, and nothing else", () => {
    seed("OPS-1", "completed", 300);
    seed("OPS-2", "completed", 5);
    seed("OPS-3", "in_progress", 1);
    seed("OPS-4", "noise", 1);

    expect(graph.getCompletedItems().map((i) => i.workItem.id)).toEqual(["OPS-2", "OPS-1"]);
  });

  it("leaves out an item merged into another", () => {
    seed("OPS-1", "completed", 10);
    seed("OPS-2", "completed", 20);
    db.db.prepare("UPDATE work_items SET merged_into = 'OPS-1' WHERE id = 'OPS-2'").run();

    expect(graph.getCompletedItems().map((i) => i.workItem.id)).toEqual(["OPS-1"]);
  });

  it("shows the last message, not the operator's close record", () => {
    seed("OPS-1", "completed", 10);
    graph.insertEvent({
      threadId: "T-OPS-1", messageId: "operator-action-1", workItemId: "OPS-1", agentId: null,
      status: "completed", confidence: 1, reason: "Operator closed", rawText: "", timestamp: at(1),
      entryType: "decision", targetedAtOperator: false,
    });

    const [item] = graph.getCompletedItems();
    expect(item.latestEvent?.reason).toBe("shipped");
    expect(item.agent?.name).toBe("Relay");
  });

  it("is served at /api/stream/done", async () => {
    seed("OPS-1", "completed", 10);
    seed("OPS-2", "blocked_on_human", 10);

    const res = await createApp(makeState(graph, db)).request("/api/stream/done");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.workItem.id)).toEqual(["OPS-1"]);
    expect(body.items[0].workItem.statusAt).toBeTruthy();
  });
});
