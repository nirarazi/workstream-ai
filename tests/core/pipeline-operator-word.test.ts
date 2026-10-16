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
function setup(text: string, answer: Classification, extra: { postedByApp?: boolean } = {}) {
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
    text, timestamp: "2026-10-16T12:00:00.000Z", platform: "slack", senderType: "human" as const, ...extra,
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

  it("doesn't take the model's guess at which items their message is about", async () => {
    // The text names no ticket; the model lists OPS-2 anyway (a candidate, or an agent's earlier message)
    const { graph, pipeline } = setup("approved, go ahead", answer({ status: "completed", workItemIds: ["OPS-1", "OPS-2"] }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-2");
  });

  it("doesn't count tickets in text they quote or forward as theirs", async () => {
    const { graph, pipeline } = setup(
      "fyi Dana\n&gt; Forwarded from #fleet-ops:\n&gt; \"Relay: OPS-2 needs your call\"\nmore of it, OPS-2 again",
      answer({ workItemIds: [] }),
    );

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
  });

  it("doesn't give an app posting under their account their word", async () => {
    const { graph, pipeline } = setup("Progress on OPS-2 this week", answer({}), { postedByApp: true });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
  });

  const line = (workItemId: string, status: Classification["status"], actionRequiredFrom: string[] | null = null) =>
    ({ workItemId, status, entryType: "progress" as const, confidence: 0.9, reason: "", title: workItemId, targetedAtOperator: false, actionRequiredFrom, nextAction: null });

  it("doesn't take a 'thanks' read as noise as their word", async () => {
    const { graph, pipeline } = setup("thanks", answer({ status: "noise", entryType: "noise", confidence: 0.7, workItemIds: [] }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
  });

  it("doesn't spread one status over several items they name without a line each", async () => {
    const { graph, pipeline } = setup("OPS-2 is done; OPS-3 is waiting on Dana", answer({ status: "blocked_on_human", actionRequiredFrom: ["U-dana"], workItemIds: ["OPS-2", "OPS-3"] }));
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", title: "OPS-3", currentAtcStatus: "completed", currentConfidence: 0.9, statusAt: "2026-10-15T08:00:00.000Z" });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-3")!.currentAtcStatus).toBe("completed");
    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getWorkItemById("OPS-2")!.currentConfidence).toBe(0.95); // untouched, not their word
  });

  it("doesn't give the thread's own item their word when they name a different one", async () => {
    const { graph, pipeline } = setup("unrelated, but OPS-2 is merged", answer({ status: "completed", confidence: 0.5 }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("completed");
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
  });

  it("hands off an item by its own line in a message about several", async () => {
    const { graph, pipeline } = setup("OPS-1 shipped. OPS-2 is blocked on Dana's decision.", answer({
      status: "completed", workItemIds: ["OPS-1", "OPS-2"],
      breakdown: [line("OPS-1", "completed"), line("OPS-2", "blocked_on_human", ["U-dana"])],
    }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
    expect(db.db.prepare("SELECT work_item_id, status FROM event_subjects ORDER BY work_item_id").all()).toEqual([
      { work_item_id: "OPS-1", status: "completed" },
      { work_item_id: "OPS-2", status: "blocked_on_human" },
    ]);
  });

  it("doesn't hand an item off on a line the model was unsure of", async () => {
    const { graph, pipeline } = setup("OPS-1 shipped. OPS-2 maybe waiting on Dana?", answer({
      status: "completed", confidence: 0.95, workItemIds: ["OPS-1", "OPS-2"],
      breakdown: [line("OPS-1", "completed"), { ...line("OPS-2", "blocked_on_human", ["U-dana"]), confidence: 0.3 }],
    }));

    await pipeline.processOnce();

    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-2");
  });

  it("doesn't let an older message of theirs, classified late, undo a newer status", async () => {
    const { graph, pipeline } = setup("Progress on OPS-2 this week", answer({}));
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", currentAtcStatus: "blocked_on_human", statusAt: "2026-10-16T13:00:00.000Z" });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
  });
});

