import { describe, it, expect, vi, afterEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const ANSWER: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "needs approval", workItemIds: [], title: "Rollback",
  targetedAtOperator: true, actionRequiredFrom: null, nextAction: null,
};
const FAILED: Classification = { ...ANSWER, status: "noise", entryType: "noise", confidence: 0.1, reason: "Classification failed", failed: "unreachable" };

const message = (id: string, threadId: string, at: string): Message =>
  ({ id, threadId, channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas", text: `Update ${id}`, timestamp: at, platform: "slack" }) as Message;
const thread = (id: string, ...at: string[]): Thread => ({
  id, channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: at[at.length - 1],
  messageCount: at.length, messages: at.map((t, i) => message(`${id}-m${i + 1}`, id, t)),
});

afterEach(() => vi.useRealTimers());

function setup(classify: ReturnType<typeof vi.fn>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-15T12:00:00.000Z"));
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]);
  const readThreads = vi.fn();
  const pipeline = new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph, linker, undefined, CONFIG);
  return { db, graph, readThreads, pipeline };
}

describe("Pipeline: late replies to threads that started before the cursor", () => {
  it("tells the adapter which threads it knows, and how far back to look", async () => {
    const { db, graph, readThreads, pipeline } = setup(vi.fn(async () => ANSWER));
    readThreads.mockResolvedValue([thread("OLD", "2026-10-13T09:00:00.000Z")]);
    await pipeline.processOnce();

    readThreads.mockResolvedValue([]);
    await pipeline.processOnce();

    const options = readThreads.mock.calls[1][3];
    expect([...options.knownThreads]).toEqual([["OLD", "2026-10-13T09:00:00.000Z"]]);
    expect(options.replyWindowStart.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    db.close();
  });

  it("classifies the late reply without moving the channel's cursor, in either direction", async () => {
    const classify = vi.fn(async () => ANSWER);
    const { db, graph, readThreads, pipeline } = setup(classify);
    graph.setPollCursor("C1", "2026-10-15T11:00:00.000Z");
    readThreads.mockResolvedValue([thread("OLD", "2026-10-13T09:00:00.000Z", "2026-10-15T11:55:00.000Z")]);

    await pipeline.processOnce();

    expect(graph.hasEvent("OLD-m2", "OLD")).toBe(true);
    expect(graph.getPollCursor("C1")?.lastTimestamp).toBe("2026-10-15T11:00:00.000Z");
    db.close();
  });

  it("doesn't pull the cursor back to an old thread whose late reply has to be retried", async () => {
    const { db, graph, readThreads, pipeline } = setup(vi.fn(async () => FAILED));
    graph.setPollCursor("C1", "2026-10-15T11:00:00.000Z");
    readThreads.mockResolvedValue([thread("OLD", "2026-10-13T09:00:00.000Z", "2026-10-15T11:55:00.000Z")]);

    await pipeline.processOnce();

    expect(graph.hasEvent("OLD-m2", "OLD")).toBe(false); // left for a retry, found again by the next read back
    expect(graph.getPollCursor("C1")?.lastTimestamp).toBe("2026-10-15T11:00:00.000Z");
    db.close();
  });
});
