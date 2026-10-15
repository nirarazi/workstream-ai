import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const DONE = { processed: 0, classified: 0, errors: 0 };

describe("Pipeline.stop during the first poll", () => {
  it("doesn't start polling once that poll finishes", async () => {
    const pipeline = new Pipeline({} as any, {} as any, {} as any, {} as any, undefined, CONFIG);
    let finishFirstPoll!: () => void;
    vi.spyOn(pipeline, "processOnce").mockImplementation(
      () => new Promise((resolve) => { finishFirstPoll = () => resolve(DONE); }),
    );

    const started = pipeline.start();
    pipeline.stop(); // e.g. a settings save during the catch-up after launch
    finishFirstPoll();
    await started;

    expect(pipeline.isPolling()).toBe(false);
    pipeline.stop();
  });

  it("leaves one timer, which stop() clears, when started again before the first poll finishes", async () => {
    const pipeline = new Pipeline({} as any, {} as any, {} as any, {} as any, undefined, CONFIG);
    const finish: Array<() => void> = [];
    vi.spyOn(pipeline, "processOnce").mockImplementation(() => new Promise((resolve) => { finish.push(() => resolve(DONE)); }));
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const first = pipeline.start();
    pipeline.stop();
    const second = pipeline.start();
    finish.forEach((f) => f());
    await Promise.all([first, second]);

    expect(setInterval).toHaveBeenCalledTimes(1);
    pipeline.stop();
    expect(pipeline.isPolling()).toBe(false);
    setInterval.mockRestore();
  });
});

describe("Pipeline.stop during a poll", () => {
  function message(id: string, threadId: string): Message {
    return {
      id, threadId, channelId: threadId === "T1" ? "C1" : "C2", channelName: "general", userId: "U-atlas", userName: "Atlas",
      text: "Blocked: need approval for OPS-101", timestamp: "2026-10-15T05:00:00.000Z", platform: "slack",
    } as Message;
  }
  const thread = (id: string): Thread => ({
    id, channelId: id === "T1" ? "C1" : "C2", channelName: "general", platform: "slack", workItemId: null,
    lastActivity: "2026-10-15T05:00:00.000Z", messageCount: 1, messages: [message(`${id}-m1`, id)],
  });

  it("makes no more calls and stores nothing from the classification it cut off", async () => {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]);
    const adapter = { name: "fake", readThreads: vi.fn(async () => [thread("T1"), thread("T2")]), getThreadMessages: vi.fn(async () => []) } as any;
    let pipeline!: Pipeline;
    const classifier = {
      // A settings save stops the pipeline mid-call; the aborted call comes back as the classifier's fallback
      classify: vi.fn(async () => {
        pipeline.stop();
        return { status: "noise", entryType: "noise", confidence: 0.1, reason: "Classification failed", workItemIds: [], title: "", targetedAtOperator: true, actionRequiredFrom: null, nextAction: null };
      }),
    } as any;
    pipeline = new Pipeline(adapter, classifier, graph, linker, undefined, CONFIG);

    const result = await pipeline.processOnce();

    expect(classifier.classify).toHaveBeenCalledTimes(1); // T2 is never sent to the model
    expect(graph.hasEvent("T1-m1", "T1")).toBe(false); // left for the next pipeline, not stored as noise
    expect(graph.getPollCursor("C1")).toBeNull(); // so the next pipeline reads T1 again
    expect(result.errors).toBe(0);
    db.close();
  });
});
