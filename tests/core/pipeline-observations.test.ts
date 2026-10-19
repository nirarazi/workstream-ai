// tests/core/pipeline-observations.test.ts — every message a poll reads is recorded once as an observation

import { describe, it, expect, vi, onTestFinished } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { observeSlackMessage } from "../../core/adapters/messaging/slack/observe.js";
import type { Classification, Message, Thread } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any;
const BLOCKED: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "needs approval", workItemIds: [], title: "Rollback",
  targetedAtOperator: true, actionRequiredFrom: null, nextAction: null,
};
const message: Message = {
  id: "1700000000.000100", threadId: "1700000000.000100", channelId: "C0OPS", channelName: "fleet-ops", userId: "U0ATLAS",
  userName: "Atlas", text: "OPS-101: deploy failed, need approval to roll back", timestamp: new Date().toISOString(), platform: "slack",
} as Message;
const thread: Thread = { id: message.threadId, channelId: "C0OPS", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] };

function setup(observe: (m: Message) => ReturnType<typeof observeSlackMessage>) {
  const db = new Database(":memory:");
  onTestFinished(() => db.close());
  const graph = new ContextGraph(db);
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
  const adapter = { name: "slack", readThreads: vi.fn(async () => [thread]), getThreadMessages: vi.fn(async () => []), observe };
  const pipeline = new Pipeline(adapter as any, { classify: vi.fn(async () => BLOCKED) } as any, graph, linker, undefined, CONFIG);
  return { db, graph, pipeline };
}

describe("Pipeline: observations", () => {
  it("records the messages it reads, once, and links each event to its observation", async () => {
    const { db, graph, pipeline } = setup((m) => observeSlackMessage(m, { teamId: "T0NORTHWND", url: null }));
    await pipeline.processOnce();
    await pipeline.processOnce();
    const rows = db.db.prepare("SELECT id, dedupe_key FROM observations").all() as Array<{ id: string; dedupe_key: string }>;
    expect(rows.map((r) => r.dedupe_key)).toEqual(["slack:T0NORTHWND/C0OPS/1700000000.000100"]);
    const event = db.db.prepare("SELECT observation_id FROM events WHERE message_id = ?").get(message.id) as { observation_id: string };
    expect(event.observation_id).toBe(rows[0].id);
    expect(graph.hasEvent(message.id, thread.id)).toBe(true);
  });

  it("still classifies when observing fails", async () => {
    const { graph, pipeline } = setup(() => { throw new Error("no workspace"); });
    await pipeline.processOnce();
    expect(graph.hasEvent(message.id, thread.id)).toBe(true);
  });
});
