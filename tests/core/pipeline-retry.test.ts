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
const UNREACHABLE: Classification = { ...ANSWER, status: "noise", entryType: "noise", confidence: 0.1, reason: "Classification failed — defaulting to noise", failed: "unreachable" };
const INVALID: Classification = { ...UNREACHABLE, failed: "invalid" };
const AUTH: Classification = { ...UNREACHABLE, failed: "auth" };
const NO_BUDGET: Classification = { ...UNREACHABLE, reason: "Daily LLM budget exhausted. Resets at midnight UTC.", failed: "budget" };

describe("Pipeline: when the model gives no answer", () => {
  let db: Database;
  let graph: ContextGraph;
  let classify: ReturnType<typeof vi.fn>;
  let readThreads: ReturnType<typeof vi.fn>;
  let pipeline: Pipeline;
  let clock: number;
  const T1 = "2026-10-15T05:00:00.000Z";
  const T2 = "2026-10-15T05:10:00.000Z";
  // Polls far enough apart that any backoff has passed
  const pollLater = async () => {
    clock += 31 * 60 * 1000;
    vi.setSystemTime(clock);
    await pipeline.processOnce();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = Date.parse("2026-10-15T08:00:00.000Z");
    vi.setSystemTime(clock);
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
    classify.mockResolvedValueOnce(UNREACHABLE).mockResolvedValueOnce(ANSWER);

    await pipeline.processOnce();

    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    expect(graph.hasEvent("T2-m1", "T2")).toBe(true);
    // T2 was classified, but the cursor stays just before T1 rather than moving past it
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe("2026-10-15T04:59:59.999Z");

    classify.mockResolvedValueOnce(ANSWER);
    await pipeline.processOnce(); // the first retry is on the very next poll

    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
    // Past T1 now (T2, already classified, is skipped and re-read cheaply)
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe(T1);
  });

  it("gives up after three unusable replies, even when nothing else is posted", async () => {
    readThreads.mockResolvedValue([thread("T1", T1)]);
    classify.mockResolvedValue(INVALID);

    await pipeline.processOnce();
    await pollLater();
    await pollLater();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    await pollLater();

    expect(graph.getEventByMessageId("T1-m1", "T1")!.status).toBe("noise");
    expect(classify).toHaveBeenCalledTimes(4);
  });

  it("backs off, so a message that keeps failing costs few calls", async () => {
    readThreads.mockResolvedValue([thread("T1", T1)]);
    classify.mockResolvedValue(UNREACHABLE);

    for (let i = 0; i < 20; i++) {
      clock += 30_000; // a poll every 30s for 10 minutes
      vi.setSystemTime(clock);
      await pipeline.processOnce();
    }

    expect(classify.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("gives up on 'couldn't reach the model' only when other messages got real answers", async () => {
    let poll = 0;
    // Each poll brings a new message that the model answers, so the model is clearly up
    readThreads.mockImplementation(async () => [thread("T1", T1), thread(`N${poll}`, `2026-10-15T06:0${poll}:00.000Z`)]);
    classify.mockImplementation(async (text: string) => (text.includes("T1") ? UNREACHABLE : ANSWER));

    await pipeline.processOnce();
    for (poll = 1; poll < 3; poll++) await pollLater();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);
    await pollLater();

    expect(graph.getEventByMessageId("T1-m1", "T1")!.status).toBe("noise");
  });

  it("doesn't use up tries during an outage, even if messages that skip the model are stored", async () => {
    // A thread on a completed item: its new messages are stored without a model call each poll
    graph.upsertWorkItem({ id: "OPS-9", source: "jira", title: "Done", currentAtcStatus: "completed" });
    graph.upsertThread({ id: "T9", channelId: "C9", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-9" });
    let poll = 0;
    readThreads.mockImplementation(async () => [thread("T1", T1), { ...thread("T9", `2026-10-15T07:0${poll}:00.000Z`, "C9"), messages: [message(`T9-r${poll}`, "T9", "C9", `2026-10-15T07:0${poll}:00.000Z`)] }]);
    classify.mockResolvedValue(UNREACHABLE);

    await pipeline.processOnce();
    for (poll = 1; poll < 6; poll++) await pollLater();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);

    classify.mockResolvedValue(ANSWER); // the model is back
    await pollLater();
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
  });

  it("pauses polling until the budget resets, then picks up where it stopped", async () => {
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

  it("doesn't let held threads take every slot, so a new message still gets classified", async () => {
    const pipelineWith = (max: number) =>
      new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph,
        new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]), undefined,
        { ...CONFIG, lookback: { maxThreadsPerPoll: max, maxActiveThreadRepolls: 0 } });
    pipeline = pipelineWith(2);
    const held = [thread("H1", "2026-10-15T04:00:00.000Z"), thread("H2", "2026-10-15T04:01:00.000Z"), thread("H3", "2026-10-15T04:02:00.000Z")];
    readThreads.mockResolvedValue(held);
    classify.mockResolvedValue(UNREACHABLE);
    await pipeline.processOnce(); // H1, H2 fail (cap 2); H3 deferred
    await pollLater(); // H3 fails; H1, H2 retried (fresh first)

    // A real new message arrives behind three older held threads
    readThreads.mockResolvedValue([...held, thread("NEW", "2026-10-15T09:00:00.000Z")]);
    classify.mockImplementation(async (text: string) => (text.includes("NEW") ? ANSWER : UNREACHABLE));
    clock += 5_000; // the held ones are still backing off
    vi.setSystemTime(clock);
    await pipeline.processOnce();

    expect(graph.getEventByMessageId("NEW-m1", "NEW")!.reason).toBe("working on it");
    // The held threads still keep the channel's cursor before them
    expect(graph.getPollCursor("C1")!.lastTimestamp).toBe("2026-10-15T03:59:59.999Z");
  });

  it("pauses for a while when the provider refuses the API key, and shows why", async () => {
    classify.mockResolvedValue(AUTH);

    await pipeline.processOnce();
    await pipeline.processOnce();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(readThreads).toHaveBeenCalledTimes(1);
    expect(pipeline.pauseReason()).toBe("auth");
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false);

    classify.mockResolvedValue(ANSWER);
    await pollLater(); // the pause is a few minutes
    expect(pipeline.pauseReason()).toBeNull();
    expect(graph.getEventByMessageId("T1-m1", "T1")!.reason).toBe("working on it");
  });

  it("doesn't let another channel's cursor skip a thread the budget stop never reached", async () => {
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

describe("Pipeline.isModelUnavailable", () => {
  it("is true after a poll with failures and no real answers, and false once the model answers", async () => {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    const classify = vi.fn().mockResolvedValue(UNREACHABLE);
    const pipeline = new Pipeline(
      { name: "fake", readThreads: vi.fn(async () => [thread("T1", "2026-10-15T05:00:00.000Z")]), getThreadMessages: vi.fn(async () => []) } as any,
      { classify } as any, graph, new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]), undefined, CONFIG,
    );
    await pipeline.processOnce();
    expect(pipeline.isModelUnavailable()).toBe(true);
    classify.mockResolvedValue(ANSWER);
    await pipeline.processOnce();
    expect(pipeline.isModelUnavailable()).toBe(false);
    db.close();
  });
});

describe("Pipeline: during an outage", () => {
  it("doesn't re-read the platform before a held message is due, and waits at most 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.parse("2026-10-15T08:00:00.000Z");
    vi.setSystemTime(clock);
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    const readThreads = vi.fn(async () => [thread("T1", "2026-10-15T05:00:00.000Z")]);
    const classify = vi.fn().mockResolvedValue(UNREACHABLE);
    const pipeline = new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph,
      new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]), undefined, CONFIG);
    const pollAfter = async (ms: number) => {
      clock += ms;
      vi.setSystemTime(clock);
      await pipeline.processOnce();
    };

    await pipeline.processOnce(); // fails; first retry is due at once
    await pollAfter(30_000); // fails again; next retry in 30s
    const readsSoFar = readThreads.mock.calls.length;
    await pollAfter(10_000); // before the retry is due: no read
    expect(readThreads.mock.calls.length).toBe(readsSoFar);
    await pollAfter(25_000); // due: reads again
    expect(readThreads.mock.calls.length).toBe(readsSoFar + 1);

    // Much later in a long outage, the wait between reads is capped at 5 minutes
    for (let i = 0; i < 12; i++) await pollAfter(31 * 60_000);
    const before = readThreads.mock.calls.length;
    await pollAfter(5 * 60_000 + 1_000);
    expect(readThreads.mock.calls.length).toBe(before + 1);

    vi.useRealTimers();
    db.close();
  });
});
