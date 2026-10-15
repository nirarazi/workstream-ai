import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;

function message(id: string, threadId: string, channelId: string, at: string): Message {
  return {
    id, threadId, channelId, channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
    text: `Update ${id}`, timestamp: at, platform: "slack",
  } as Message;
}
function thread(id: string, at: string, channelId = "C1", replyAt?: string): Thread {
  const messages = [message(`${id}-m1`, id, channelId, at)];
  if (replyAt) messages.push(message(`${id}-m2`, id, channelId, replyAt));
  return { id, channelId, channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: replyAt ?? at, messageCount: messages.length, messages };
}

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
  let readThreads: ReturnType<typeof vi.fn>;
  let pipeline: Pipeline;
  const T1 = "2026-10-15T05:00:00.000Z";
  const T2 = "2026-10-15T05:10:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]);
    readThreads = vi.fn(async () => [thread("T1", T1), thread("T2", T2)]);
    classify = vi.fn();
    pipeline = new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph, linker, undefined, CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("stores nothing for it and keeps the channel before its thread, so the next poll tries again", async () => {
    classify.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(ANSWER);

    await pipeline.processOnce();

    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    expect(graph.hasEvent("T2-m1", "T2")).toBe(true);
    // T2 was classified, but the cursor stays just before T1 rather than moving past it
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe("2026-10-15T04:59:59.999Z");

    classify.mockResolvedValueOnce(ANSWER);
    await pipeline.processOnce();

    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
    // Past T1 now (T2, already classified, is skipped and re-read cheaply)
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe(T1);
  });

  it("stores it as noise after three tries that failed while other messages got through", async () => {
    let poll = 0;
    // Each poll brings a new message that the model answers, so the model is clearly up
    readThreads.mockImplementation(async () => [thread("T1", T1), thread(`N${poll}`, `2026-10-15T06:0${poll}:00.000Z`)]);
    classify.mockImplementation(async (text: string) => (text.includes("T1") ? FAILED : ANSWER));

    for (poll = 0; poll < 3; poll++) await pipeline.processOnce();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    await pipeline.processOnce();

    expect(graph.getEventByMessageId("T1-m1", "T1")!.status).toBe("noise");
  });

  it("doesn't use up tries during an outage, when nothing gets through", async () => {
    classify.mockResolvedValue(FAILED);
    for (let i = 0; i < 5; i++) await pipeline.processOnce();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);

    classify.mockResolvedValue(ANSWER); // the model is back
    await pipeline.processOnce();
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
  });

  it("pauses polling until the budget resets, then picks up where it stopped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    classify.mockResolvedValue(NO_BUDGET);

    await pipeline.processOnce();
    await pipeline.processOnce();
    await pipeline.processOnce();

    expect(classify).toHaveBeenCalledTimes(1); // T2 isn't tried once T1 hits the budget
    expect(readThreads).toHaveBeenCalledTimes(1); // paused: no Slack reads until the reset
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);

    vi.setSystemTime(new Date("2026-10-16T00:00:01.000Z")); // midnight UTC: the budget resets
    classify.mockResolvedValue(ANSWER);
    await pipeline.processOnce();
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
    expect(graph.hasEvent("T2-m1", "T2")).toBe(true);
  });

  it("doesn't let another channel's cursor skip a thread the budget stop never reached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    // B1 (channel B) starts first but has a late reply; A1 (channel A) hits the budget; B2 is never reached
    readThreads.mockResolvedValue([
      thread("B1", "2026-10-15T05:00:00.000Z", "CB", "2026-10-15T05:50:00.000Z"),
      thread("A1", "2026-10-15T05:10:00.000Z", "CA"),
      thread("B2", "2026-10-15T05:20:00.000Z", "CB"),
    ]);
    classify.mockImplementation(async (text: string) => (text.includes("A1") ? NO_BUDGET : ANSWER));

    await pipeline.processOnce();

    expect(graph.hasEvent("B2-m1", "B2")).toBe(false);
    // Channel B stays before B2 rather than moving to B1's late reply
    expect(graph.getPollCursor("CB")!.lastTimestamp).toBe("2026-10-15T05:19:59.999Z");
  });
});
