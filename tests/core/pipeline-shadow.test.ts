// tests/core/pipeline-shadow.test.ts — the v2 grouping in shadow mode after polls: when it runs, and that it never stops polling

import { describe, it, expect, vi, onTestFinished, afterEach } from "vitest";
import { Pipeline, SHADOW_MIN_INTERVAL_MS } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const CLASSIFIED: Classification = {
  status: "in_progress", entryType: "progress", confidence: 0.9, reason: "working", workItemIds: [], title: "Export",
  targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
};

function message(n: number): Message {
  const ts = `170000000${n}.000100`;
  return {
    id: ts, threadId: ts, channelId: "C0OPS", channelName: "fleet-ops", userId: "U0ATLAS", userName: "Atlas",
    text: `OPS-10${n}: export step ${n} done`, timestamp: new Date(Date.UTC(2026, 9, 19, 9, n)).toISOString(), platform: "slack",
  } as Message;
}

function setup() {
  const db = new Database(":memory:");
  onTestFinished(() => db.close());
  const graph = new ContextGraph(db);
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
  const threads: Thread[] = [];
  const adapter = { name: "slack", readThreads: vi.fn(async () => threads), getThreadMessages: vi.fn(async () => []) };
  const pipeline = new Pipeline(adapter as any, { classify: vi.fn(async () => CLASSIFIED) } as any, graph, linker, undefined, CONFIG);
  const post = (n: number) => {
    const m = message(n);
    threads.splice(0, threads.length, { id: m.threadId, channelId: "C0OPS", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: m.timestamp, messageCount: 1, messages: [m] });
  };
  const cases = () => (db.db.prepare("SELECT COUNT(*) AS n FROM v2_cases").get() as { n: number }).n;
  return { graph, pipeline, post, cases };
}

describe("Pipeline: shadow grouping", () => {
  afterEach(() => {
    delete process.env.WORKSTREAM_SHADOW_GROUPING;
  });

  it("regroups after a poll that added messages, then waits the interval before the next run", async () => {
    const { pipeline, post, cases } = setup();
    post(1);
    await pipeline.processOnce();
    pipeline.regroupShadow(1_000_000);
    expect(cases()).toBe(1);
    post(2);
    await pipeline.processOnce();
    pipeline.regroupShadow(1_000_000 + SHADOW_MIN_INTERVAL_MS - 1);
    expect(cases()).toBe(1);
    // A later poll picks up what the skipped one added
    pipeline.regroupShadow(1_000_000 + SHADOW_MIN_INTERVAL_MS);
    expect(cases()).toBe(2);
  });

  it("regroups when the operator's constraints change, though no message was added", async () => {
    const { graph, pipeline, post } = setup();
    post(1);
    await pipeline.processOnce();
    const spy = vi.spyOn(graph, "regroupShadow");
    pipeline.regroupShadow(1_000_000);
    pipeline.regroupShadow(1_000_000 + SHADOW_MIN_INTERVAL_MS);
    graph.constraints.add({ kind: "not_an_item", a: "slack:T0NORTHWND/C0OPS/1700000001.000100", decidedBy: "operator" });
    pipeline.regroupShadow(1_000_000 + 2 * SHADOW_MIN_INTERVAL_MS);
    // Nothing changed for the second, a constraint was added before the third
    expect(spy.mock.results.map((r) => r.value.run !== null)).toEqual([true, false, true]);
  });

  it("is off with WORKSTREAM_SHADOW_GROUPING=false", async () => {
    process.env.WORKSTREAM_SHADOW_GROUPING = "false";
    const { graph, pipeline, post } = setup();
    post(1);
    await pipeline.processOnce();
    const spy = vi.spyOn(graph, "regroupShadow");
    pipeline.regroupShadow(1_000_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs a failure and keeps polling", async () => {
    const { graph, pipeline, post } = setup();
    vi.spyOn(graph, "regroupShadow").mockImplementation(() => { throw new Error("disk full"); });
    post(1);
    await pipeline.processOnce();
    expect(() => pipeline.regroupShadow(1_000_000)).not.toThrow();
    post(2);
    const r = await pipeline.processOnce();
    expect(r.processed).toBe(1);
  });
});
