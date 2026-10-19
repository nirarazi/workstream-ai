// tests/core/pipeline-merged-refs.test.ts — a message naming a merged item's ticket counts for the item it went into

import { describe, it, expect, vi, onTestFinished } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const BLOCKED: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "needs approval", workItemIds: ["OPS-101"], title: "Rollback",
  targetedAtOperator: true, actionRequiredFrom: null, nextAction: null,
};

describe("Pipeline: references to a merged item", () => {
  it("links the thread and the event to the item the ticket was merged into, and updates that item", async () => {
    const db = new Database(":memory:");
    onTestFinished(() => db.close());
    const graph = new ContextGraph(db);
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Export" });
    graph.upsertWorkItem({ id: "OPS-200", source: "jira", title: "Export, the real one" });
    graph.mergeWorkItems("OPS-101", "OPS-200");

    const message = {
      id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U0ATLAS", userName: "Atlas",
      text: "OPS-101: deploy failed, need approval to roll back", timestamp: new Date().toISOString(), platform: "slack",
    } as Message;
    const thread: Thread = { id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] };
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
    const adapter = { name: "fake", readThreads: vi.fn(async () => [thread]), getThreadMessages: vi.fn(async () => []) };
    const pipeline = new Pipeline(adapter as any, { classify: vi.fn(async () => BLOCKED) } as any, graph, linker, undefined, CONFIG);

    await pipeline.processOnce();

    expect(graph.getThreadById("T1")!.workItemId).toBe("OPS-200");
    expect(graph.getEventsForWorkItem("OPS-200").map((e) => e.messageId)).toEqual(["m1"]);
    expect(graph.getEventsForWorkItem("OPS-101")).toEqual([]);
    expect(graph.getWorkItemById("OPS-200")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getWorkItemsForThread("T1").map((l) => l.workItemId)).toEqual(["OPS-200"]);
  });

  it("counts IDs that name one item once when deciding whether a message is a digest", async () => {
    const db = new Database(":memory:");
    onTestFinished(() => db.close());
    const graph = new ContextGraph(db);
    for (const id of ["OPS-1", "OPS-2", "OPS-3", "OPS-50"]) graph.upsertWorkItem({ id, source: "jira" });
    graph.mergeWorkItems("OPS-2", "OPS-1");
    graph.mergeWorkItems("OPS-3", "OPS-1");
    graph.upsertThread({ id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-50" });
    const message = {
      id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U0ATLAS", userName: "Atlas",
      text: "OPS-50 waits on OPS-1, OPS-2 and OPS-3", timestamp: new Date().toISOString(), platform: "slack", senderType: "agent",
    } as Message;
    const thread: Thread = { id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-50", lastActivity: message.timestamp, messageCount: 1, messages: [message] };
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
    const adapter = { name: "fake", readThreads: vi.fn(async () => [thread]), getThreadMessages: vi.fn(async () => []) };
    const pipeline = new Pipeline(adapter as any, { classify: vi.fn(async () => ({ ...BLOCKED, workItemIds: [] })) } as any, graph, linker, undefined, CONFIG);
    await pipeline.processOnce();
    const row = db.db.prepare("SELECT digest FROM events WHERE message_id = 'm1'").get() as { digest: number };
    expect(row.digest).toBe(0);
  });
});
