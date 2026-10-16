// tests/core/pipeline-operator-word.test.ts — the operator's own message is their word on the items it's about

import { describe, it, expect, vi, afterEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification } from "../../core/types.js";

const OPERATOR = "U0OPERATOR1";
let db: Database;
afterEach(() => db?.close());

/** A thread owned by OPS-1, with OPS-2 (blocked on the operator, in Needs me) from another thread */
function setup(text: string, answer: Classification) {
  db = new Database(":memory:");
  const graph = new ContextGraph(db);
  graph.upsertAgent({ id: "U-relay", name: "Relay", platform: "slack", platformUserId: "U-relay", isBot: true });
  for (const id of ["OPS-1", "OPS-2"]) graph.upsertWorkItem({ id, source: "jira", title: id, currentAtcStatus: "blocked_on_human", currentConfidence: 0.95, statusAt: "2026-10-15T08:00:00.000Z" });
  for (const [thread, item] of [["T-ONE", "OPS-1"], ["T-TWO", "OPS-2"]]) {
    graph.upsertThread({ id: thread, channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: item, lastActivity: "2026-10-15T08:00:00.000Z" });
    graph.linkThreadWorkItem(thread, item, "primary");
    graph.insertEvent({ threadId: thread, messageId: `${thread}-ask`, workItemId: item, agentId: "U-relay", status: "blocked_on_human", confidence: 0.95, rawText: `Need your call on ${item}`, timestamp: "2026-10-15T08:00:00.000Z", entryType: "block", targetedAtOperator: true });
  }
  const message = {
    id: "m-op", threadId: "T-ONE", channelId: "C1", channelName: "fleet-ops", userId: OPERATOR, userName: "Alex",
    text, timestamp: "2026-10-16T12:00:00.000Z", platform: "slack", senderType: "human" as const,
  };
  const adapter = {
    name: "fake",
    readThreads: vi.fn(async () => [{ id: "T-ONE", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1", lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
    getThreadMessages: vi.fn(async () => []),
  } as any;
  const pipeline = new Pipeline(
    adapter, { classify: vi.fn(async () => answer) } as any, graph,
    new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]),
    undefined,
    { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 }, taskAdapter: { ticketPrefixes: [] } } as any,
    new Map([["slack", { userId: OPERATOR, userName: "alex" }]]),
  );
  return { graph, pipeline };
}

const answer = (overrides: Partial<Classification>): Classification => ({
  status: "in_progress", entryType: "progress", confidence: 0.81, reason: "operator's update", workItemIds: ["OPS-2"],
  title: "Update", targetedAtOperator: false, actionRequiredFrom: [], nextAction: null, ...overrides,
});

describe("Pipeline: the operator's word", () => {
  it("updates the items their message names, however sure the model was of earlier messages", async () => {
    const { graph, pipeline } = setup("Progress on OPS-2 this week, but still not ready", answer({}));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("in_progress");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
  });

  it("hands an item off when they say it's waiting on someone else", async () => {
    const { graph, pipeline } = setup("OPS-2: Dana and Sam are blocking on decisions", answer({
      status: "blocked_on_human", entryType: "block", confidence: 0.85, actionRequiredFrom: ["U-dana", "U-sam"],
    }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
  });

  it("never puts an item in front of them from their own message", async () => {
    const { graph, pipeline } = setup("OPS-2 needs my sign-off", answer({
      breakdown: [{ workItemId: "OPS-2", status: "needs_decision", entryType: "block", confidence: 0.9, reason: "", title: "OPS-2", targetedAtOperator: true, actionRequiredFrom: [OPERATOR], nextAction: null }],
    }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("in_progress");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM event_targets").get()).toEqual({ n: 0 });
  });

  it("leaves an item it merely mentions in a thread, without naming it, as it was", async () => {
    const { graph, pipeline } = setup("Thanks, looking", answer({ workItemIds: [] }));
    graph.linkThreadWorkItem("T-ONE", "OPS-2", "mentioned");

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-2");
  });
});
