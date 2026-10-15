import { describe, it, expect, vi, afterEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const BLOCKED: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "needs approval", workItemIds: [], title: "Rollback",
  targetedAtOperator: true, actionRequiredFrom: null, nextAction: null,
};
const message: Message = {
  id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
  text: "OPS-101: deploy failed, need approval to roll back", timestamp: "2026-10-15T11:50:00.000Z", platform: "slack",
} as Message;
const thread: Thread = { id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] };

afterEach(() => vi.useRealTimers());

describe("Pipeline: a write failing after classification", () => {
  it("leaves nothing half-written, and the retry still updates the work item", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:00.000Z"));
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
    const classify = vi.fn(async () => BLOCKED);
    const readThreads = vi.fn(async () => [thread]);
    const pipeline = new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph, linker, undefined, CONFIG);
    // After classification the event is stored, then linking it to its work item (step 6) fails, once. The linker's
    // own call, before classification, goes through.
    const realLink = graph.linkThreadWorkItem.bind(graph);
    let calls = 0;
    const link = vi.spyOn(graph, "linkThreadWorkItem").mockImplementation((...args) => {
      if (++calls === 2) throw new Error("SQLITE_BUSY");
      return realLink(...args);
    });

    await pipeline.processOnce();
    expect(graph.hasEvent("m1", "T1")).toBe(false); // rolled back with the rest
    expect(graph.getWorkItemById("OPS-101")?.currentAtcStatus ?? null).not.toBe("blocked_on_human");

    await pipeline.processOnce(); // the retry, on the next poll
    expect(graph.hasEvent("m1", "T1")).toBe(true);
    expect(graph.getWorkItemById("OPS-101")?.currentAtcStatus).toBe("blocked_on_human");
    expect(calls).toBeGreaterThan(2); // step 6 really ran again
    link.mockRestore();
    db.close();
  });
});
