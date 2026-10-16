// tests/core/pipeline-digests.test.ts — messages naming several work items inform them but don't decide them

import { describe, it, expect, vi, afterEach } from "vitest";
import { Pipeline, DIGEST_MIN_ITEMS } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 }, taskAdapter: { ticketPrefixes: [] } } as any;
const extractor = () => new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] });

function breakdown(workItemId: string, status: Classification["status"], targetedAtOperator = false) {
  return { workItemId, status, entryType: "progress" as const, confidence: 0.9, reason: "", title: workItemId, targetedAtOperator, actionRequiredFrom: null, nextAction: null };
}

let db: Database;
afterEach(() => db?.close());

function setup(text: string, answer: Classification, threadId = "T-DIGEST") {
  db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const linker = new WorkItemLinker(graph, [extractor()]);
  const message = {
    id: "m1", threadId, channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
    text, timestamp: "2026-10-15T09:00:00.000Z", platform: "slack", senderType: "agent" as const,
  };
  const adapter = {
    name: "fake",
    readThreads: vi.fn(async () => [{ id: threadId, channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
    getThreadMessages: vi.fn(async () => []),
  } as any;
  const pipeline = new Pipeline(adapter, { classify: vi.fn(async () => answer) } as any, graph, linker, undefined, CONFIG);
  return { graph, pipeline };
}

const DIGEST_TEXT = "Daily digest: OPS-1 still blocked on Alex, OPS-2 blocked on review, OPS-3 shipped";
const DIGEST_ANSWER: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "digest asks the operator for two things",
  workItemIds: ["OPS-1", "OPS-2", "OPS-3"], title: "Daily digest", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: null,
  breakdown: [breakdown("OPS-1", "blocked_on_human", true), breakdown("OPS-2", "blocked_on_human", true), breakdown("OPS-3", "completed")],
};

describe("Pipeline: digests", () => {
  it("names a digest from DIGEST_MIN_ITEMS work items", () => {
    expect(DIGEST_MIN_ITEMS).toBe(3);
  });

  it("checks what a digest says against each item instead of changing it", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", currentConfidence: 0.5 });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human", currentConfidence: 0.5 });
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", title: "Three", currentAtcStatus: "completed", currentConfidence: 0.5 });

    await pipeline.processOnce();

    // Statuses are untouched, even where the digest disagrees
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("in_progress");
    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    const checks = db.db.prepare("SELECT work_item_id, digest_status, item_status, agrees FROM digest_checks ORDER BY work_item_id").all();
    expect(checks).toEqual([
      { work_item_id: "OPS-1", digest_status: "blocked_on_human", item_status: "in_progress", agrees: 0 },
      { work_item_id: "OPS-2", digest_status: "blocked_on_human", item_status: "blocked_on_human", agrees: 1 },
      { work_item_id: "OPS-3", digest_status: "completed", item_status: "completed", agrees: 1 },
    ]);
    expect(graph.getOpenDigestDisagreements().map((d) => d.workItemId)).toEqual(["OPS-1"]);

    // None of them becomes the thread's own; the digest still shows in each one's timeline
    expect(graph.getThreadById("T-DIGEST")!.workItemId).toBeNull();
    const links = db.db.prepare("SELECT work_item_id, relation FROM thread_work_items WHERE thread_id = 'T-DIGEST' ORDER BY work_item_id").all();
    expect(links).toEqual([
      { work_item_id: "OPS-1", relation: "mentioned" },
      { work_item_id: "OPS-2", relation: "mentioned" },
      { work_item_id: "OPS-3", relation: "mentioned" },
    ]);
    expect(graph.getEventByMessageId("m1", "T-DIGEST")!.digest).toBe(true);
  });

  it("doesn't put the items it names in Needs me", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human" });

    await pipeline.processOnce();

    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
  });

  it("leaves a message naming fewer items as it was", async () => {
    const answer: Classification = {
      ...DIGEST_ANSWER, workItemIds: ["OPS-1", "OPS-2"], breakdown: [breakdown("OPS-1", "blocked_on_human", true), breakdown("OPS-2", "completed")],
    };
    const { graph, pipeline } = setup("OPS-1 is blocked on Alex; OPS-2 shipped", answer, "T-PAIR");
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", currentConfidence: 0.5 });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getThreadById("T-PAIR")!.workItemId).toBe("OPS-1");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-1");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks").get()).toEqual({ n: 0 });
  });

  it("marks digests stored before they were told apart, and stops them putting items in Needs me", () => {
    db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T-OLD", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OLD", "OPS-1", "primary");
    const base = { threadId: "T-OLD", workItemId: "OPS-1", agentId: "U-atlas", status: "blocked_on_human" as const, confidence: 0.9, entryType: "block" as const, targetedAtOperator: true };
    graph.insertEvent({ ...base, messageId: "d1", rawText: DIGEST_TEXT, timestamp: "2026-10-15T09:00:00.000Z" });
    graph.insertEvent({ ...base, messageId: "p1", rawText: "OPS-1 waiting on OPS-2", timestamp: "2026-10-14T09:00:00.000Z" });
    expect(graph.getActionableItems()[0].latestEvent!.messageId).toBe("d1");

    expect(graph.backfillDigests([extractor()], DIGEST_MIN_ITEMS)).toBe(1);
    expect(graph.backfillDigests([extractor()], DIGEST_MIN_ITEMS)).toBe(0); // already marked

    // The item stays only on the strength of its own message
    expect(graph.getActionableItems()[0].latestEvent!.messageId).toBe("p1");
  });
});
