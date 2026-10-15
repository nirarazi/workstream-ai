import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;

function message(id: string, threadId: string, at: string): Message {
  return {
    id, threadId, channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
    text: `Update ${id}`, timestamp: at, platform: "slack",
  } as Message;
}
const thread = (id: string, at: string): Thread => ({
  id, channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null,
  lastActivity: at, messageCount: 1, messages: [message(`${id}-m1`, id, at)],
});

const ANSWER: Classification = {
  status: "in_progress", entryType: "progress", confidence: 0.9, reason: "working on it", workItemIds: [], title: "Update",
  targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
};
const FAILED: Classification = { ...ANSWER, status: "noise", entryType: "noise", confidence: 0.1, reason: "Classification failed — defaulting to noise", failed: "error" };
const NO_BUDGET: Classification = { ...FAILED, reason: "Daily LLM budget exhausted. Resets at midnight UTC.", failed: "budget" };

describe("Pipeline: when the model gives no answer", () => {
  let db: Database;
  let graph: ContextGraph;
  let classify: ReturnType<typeof vi.fn>;
  let pipeline: Pipeline;
  const T1 = "2026-10-15T05:00:00.000Z";
  const T2 = "2026-10-15T05:10:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]);
    const adapter = { name: "fake", readThreads: vi.fn(async () => [thread("T1", T1), thread("T2", T2)]), getThreadMessages: vi.fn(async () => []) } as any;
    classify = vi.fn();
    pipeline = new Pipeline(adapter, { classify } as any, graph, linker, undefined, CONFIG);
  });

  afterEach(() => db.close());

  it("stores nothing for it and keeps the channel before its thread, so the next poll tries again", async () => {
    classify.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(ANSWER);

    await pipeline.processOnce();

    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    expect(graph.hasEvent("T2-m1", "T2")).toBe(true);
    // T2 was classified, but the cursor stays just before T1 rather than moving past it
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe("2026-10-15T04:59:59.999Z");

    classify.mockResolvedValueOnce(ANSWER);
    await pipeline.processOnce();

    expect(graph.hasEvent("T1-m1", "T1")).toBe(true);
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
    // Past T1 now (T2, already classified, is skipped and re-read cheaply)
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe(T1);
  });

  it("stores it as noise after three failed tries, so one bad message can't hold the channel back forever", async () => {
    classify.mockImplementation(async (text: string) => (text.includes("T1") ? FAILED : ANSWER));

    await pipeline.processOnce();
    await pipeline.processOnce();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    await pipeline.processOnce();

    expect(graph.getEventByMessageId("T1-m1", "T1")!.status).toBe("noise");
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe(T1);
  });

  it("pauses the poll when the daily budget is spent, without using up any tries", async () => {
    classify.mockResolvedValue(NO_BUDGET);

    for (let i = 0; i < 4; i++) await pipeline.processOnce();

    expect(classify).toHaveBeenCalledTimes(4); // one call per poll: T2 isn't attempted once T1 hits the budget
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);

    classify.mockResolvedValue(ANSWER); // the budget resets
    await pipeline.processOnce();
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
    expect(graph.hasEvent("T2-m1", "T2")).toBe(true);
  });
});
