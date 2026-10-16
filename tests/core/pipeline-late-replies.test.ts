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
    expect([...options.knownThreads]).toEqual([["OLD", { latestAt: "2026-10-13T09:00:00.000Z", messageCount: 1 }]]);
    expect(options.replyWindowStart.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(options.pollIntervalMs).toBe((CONFIG as any).messaging.pollInterval * 1000); // so the adapter can fit its reads
    db.close();
  });

  it("reports a missed message in the count, so the thread is read in full again, even after a restart", async () => {
    const classify = vi.fn(async (text: string) => (text.includes("OLD-m2") ? FAILED : ANSWER));
    const { db, graph, readThreads, pipeline } = setup(classify);
    readThreads.mockResolvedValue([thread("OLD", "2026-10-15T09:00:00.000Z", "2026-10-15T09:05:00.000Z", "2026-10-15T09:10:00.000Z")]);
    // m2 fails twice; then m3 goes ahead of it
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      await pipeline.processOnce();
    }
    expect(graph.hasEvent("OLD-m3", "OLD")).toBe(true);
    expect(graph.hasEvent("OLD-m2", "OLD")).toBe(false);

    // A settings save builds a new pipeline, which knows nothing of the old one's retries
    const fresh = new Pipeline({ name: "fake", readThreads, getThreadMessages: vi.fn(async () => []) } as any, { classify } as any, graph,
      new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]), undefined, CONFIG);
    readThreads.mockResolvedValue([]);
    await fresh.processOnce();

    // Two of its three messages processed: the adapter sees reply_count + 1 = 3 > 2 and fetches it in full
    const known = readThreads.mock.calls[readThreads.mock.calls.length - 1][3].knownThreads.get("OLD");
    expect(known).toEqual({ latestAt: "2026-10-15T09:10:00.000Z", messageCount: 2 });
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

  it("backs off after an unexpected error storing a message, instead of retrying it every poll", async () => {
    const classify = vi.fn(async () => ANSWER);
    const { db, graph, readThreads, pipeline } = setup(classify);
    readThreads.mockResolvedValue([thread("T1", "2026-10-15T11:50:00.000Z")]);
    const upsertThread = vi.spyOn(graph, "upsertThread").mockImplementation(() => { throw new Error("SQLITE_BUSY"); });

    for (let i = 0; i < 5; i++) await pipeline.processOnce();
    expect(upsertThread.mock.calls.length).toBe(2); // the first try and the next-poll retry; then it waits

    upsertThread.mockRestore();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await pipeline.processOnce();
    expect(graph.hasEvent("T1-m1", "T1")).toBe(true);
    db.close();
  });
});
