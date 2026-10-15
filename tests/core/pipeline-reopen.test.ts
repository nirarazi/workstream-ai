import { describe, it, expect, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { Pipeline } from "../../core/pipeline.js";
import type { Message } from "../../core/types.js";

function setup(status: string, confidence = 0.6) {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifyFn = vi.fn().mockResolvedValue({ status, confidence, reason: "r", workItemIds: [], title: "t" });
  const classifier = new Classifier({ name: "mock", classify: classifyFn }, "sys", []);
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
  const pipeline = new Pipeline({ name: "test", displayName: "Test" } as any, classifier, graph, linker);
  // Approved an hour ago, with a confident status
  graph.upsertWorkItem({ id: "OPS-101", source: "jira", currentAtcStatus: "completed", currentConfidence: 0.99, statusAt: "2026-10-15T08:00:00.000Z" });
  graph.upsertThread({ id: "t1", channelId: "C1", platform: "test", workItemId: "OPS-101" });
  return { db, graph, classifyFn, pipeline };
}

const message = (over: Partial<Message> = {}): Message => ({
  id: "m-new", threadId: "t1", channelId: "C1", channelName: "fleet-ops", text: "OPS-101: the deploy failed again, need you to approve a rollback",
  userId: "U-atlas", userName: "Atlas", platform: "test", senderType: "agent", timestamp: "2026-10-15T09:00:00.000Z", ...over,
});

describe("Messages on a completed work item", () => {
  it("are classified, and a blocker brings the item back to the inbox, marked reopened", async () => {
    const { db, graph, classifyFn, pipeline } = setup("blocked_on_human");

    await pipeline.processMessage(message(), "t1", "C1");

    expect(classifyFn).toHaveBeenCalledTimes(1);
    const item = graph.getWorkItemById("OPS-101")!;
    expect(item.currentAtcStatus).toBe("blocked_on_human"); // even though less confident than the completion
    expect(item.reopenedAt).toBe("2026-10-15T09:00:00.000Z");
    db.close();
  });

  it("reopen it for a decision too", async () => {
    const { db, graph, pipeline } = setup("needs_decision");
    await pipeline.processMessage(message(), "t1", "C1");
    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBe("needs_decision");
    db.close();
  });

  it("leave it completed when an agent just reports progress or chatter", async () => {
    for (const status of ["in_progress", "noise"]) {
      const { db, graph, pipeline } = setup(status, 1);
      await pipeline.processMessage(message({ text: "OPS-101: thanks, merged and deployed" }), "t1", "C1");
      const item = graph.getWorkItemById("OPS-101")!;
      expect(item.currentAtcStatus).toBe("completed");
      expect(item.reopenedAt).toBeNull();
      db.close();
    }
  });

  it("reopen it as in progress when a human says work resumed", async () => {
    const { db, graph, pipeline } = setup("in_progress");
    await pipeline.processMessage(message({ userId: "U0OPERATOR1", userName: "Dana", senderType: "human", text: "Reopening OPS-101, Relay pick it up again" }), "t1", "C1");
    const item = graph.getWorkItemById("OPS-101")!;
    expect(item.currentAtcStatus).toBe("in_progress");
    expect(item.reopenedAt).toBe("2026-10-15T09:00:00.000Z");
    db.close();
  });

  it("don't reopen it when the message was posted before it was closed (classified late)", async () => {
    const { db, graph, pipeline } = setup("blocked_on_human");
    await pipeline.processMessage(message({ timestamp: "2026-10-15T07:30:00.000Z" }), "t1", "C1");
    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBe("completed");
    db.close();
  });
});
