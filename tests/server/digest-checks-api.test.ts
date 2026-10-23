// tests/server/digest-checks-api.test.ts — the operator decides the digest disagreements the judge couldn't settle

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";
import type { StatusCategory } from "../../core/types.js";

const DIGEST_AT = "2026-10-15T09:00:00.000Z";
let db: Database;
let graph: ContextGraph;

function makeState() {
  return {
    config: { server: { port: 9847, host: "127.0.0.1" } },
    db, graph,
    classifier: { classify: vi.fn() },
    pipeline: null, messagingAdapter: null, taskAdapter: null,
    operatorIdentities: new Map(), startedAt: new Date(),
  } as any;
}

/** A check the judge left for the operator: the digest says `digestStatus` about an item the app sees as `itemStatus` */
function waiting(id: string, itemStatus: StatusCategory, digestStatus: StatusCategory, targeted = false, fromLine = true): string {
  graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: itemStatus, statusAt: "2026-10-14T09:00:00.000Z" });
  const eventId = graph.getEventByMessageId("d1", "T-DIGEST")!.id;
  graph.recordDigestCheck({ eventId, workItemId: id, digestStatus, digestTargeted: targeted, itemStatus, at: DIGEST_AT, fromLine });
  graph.markDigestCheckUnsure(eventId, id, "The messages don't settle it");
  return eventId;
}

const get = () => createApp(makeState()).request("/api/digest-checks");
const decide = (body: unknown) => createApp(makeState()).request("/api/digest-checks/decide", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  db = new Database(":memory:");
  graph = new ContextGraph(db);
  graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
  graph.upsertThread({ id: "T-DIGEST", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null });
  graph.insertEvent({ threadId: "T-DIGEST", messageId: "d1", workItemId: null, agentId: "U-atlas", status: "in_progress", confidence: 0.9, rawText: "Daily: OPS-1 done, OPS-2 blocked on Alex, OPS-3 moving", timestamp: DIGEST_AT, digest: true });
});
afterEach(() => db.close());

describe("digest checks for the operator", () => {
  it("lists what the judge left, with both views, and settles the ones that went stale first", async () => {
    waiting("OPS-1", "blocked_on_human", "completed");
    waiting("OPS-3", "blocked_on_human", "completed");
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", currentAtcStatus: "blocked_on_human", statusAt: "2026-10-15T10:00:00.000Z" }); // moved on

    const body = await (await get()).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      workItemId: "OPS-1", title: "Item OPS-1", appStatus: "blocked_on_human", digestStatus: "completed",
      sender: "Atlas", judgeNote: "The messages don't settle it", digestText: "Daily: OPS-1 done, OPS-2 blocked on Alex, OPS-3 moving",
    });
  });

  it("doesn't show one where neither side needs the operator, unless it's done against in progress, and keeps the app's view", async () => {
    waiting("OPS-1", "noise", "completed");
    waiting("OPS-3", "completed", "noise");
    waiting("OPS-5", "completed", "in_progress");

    expect((await (await get()).json()).items.map((i: { workItemId: string }) => i.workItemId)).toEqual(["OPS-5"]);
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("noise");
    expect(db.db.prepare("SELECT resolution FROM digest_checks WHERE work_item_id = 'OPS-1'").get()).toEqual({ resolution: "no_attention" });
  });

  it("keeps the app's view when the operator says so", async () => {
    const eventId = waiting("OPS-1", "blocked_on_human", "completed");

    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "app" })).status).toBe(200);

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect((await (await get()).json()).items).toEqual([]);
  });

  it("takes the digest's view when the operator says so, whatever it is", async () => {
    const eventId = waiting("OPS-1", "blocked_on_human", "completed");

    await decide({ eventId, workItemId: "OPS-1", verdict: "digest" });

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("completed");
    expect(graph.getCompletedItems().map((i) => i.workItem.id)).toContain("OPS-1");
  });

  it("puts an item in Needs me when the operator agrees the digest says it needs them", async () => {
    const eventId = waiting("OPS-2", "in_progress", "blocked_on_human", true);

    await decide({ eventId, workItemId: "OPS-2", verdict: "digest" });

    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-2"]);
  });

  it("refuses a malformed decision, and one for a check that isn't waiting", async () => {
    const eventId = waiting("OPS-1", "blocked_on_human", "completed");
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "maybe" })).status).toBe(400);
    expect((await decide({ eventId, workItemId: "OPS-9", verdict: "app" })).status).toBe(404);
    await decide({ eventId, workItemId: "OPS-1", verdict: "app" });
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "digest" })).status).toBe(404);
  });

  it("leaves the item free to move with later messages after the operator sides with the digest", async () => {
    const eventId = waiting("OPS-2", "in_progress", "blocked_on_human", true);
    await decide({ eventId, workItemId: "OPS-2", verdict: "digest" });
    expect(graph.getEventsForWorkItem("OPS-2").map((e) => e.reason)).toContain("Operator sided with Atlas's digest");

    // A later message about the item, through the pipeline, still moves it
    const message = { id: "m9", threadId: "T-OWN", channelId: "C1", channelName: "fleet-ops", userId: "U-relay", userName: "Relay", text: "OPS-2 is unblocked and moving", timestamp: new Date(Date.now() + 60_000).toISOString(), platform: "slack", senderType: "agent" as const };
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-2" });
    graph.linkThreadWorkItem("T-OWN", "OPS-2", "primary");
    const { Pipeline } = await import("../../core/pipeline.js");
    const { WorkItemLinker } = await import("../../core/graph/linker.js");
    const pipeline = new Pipeline(
      { name: "fake", readThreads: vi.fn(async () => [{ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-2", lastActivity: message.timestamp, messageCount: 1, messages: [message] }]), getThreadMessages: vi.fn(async () => []) } as any,
      { classify: vi.fn(async () => ({ status: "in_progress", entryType: "progress", confidence: 0.9, reason: "moving", workItemIds: ["OPS-2"], title: "Two", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null })) } as any,
      graph, new WorkItemLinker(graph, []), undefined,
      { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 } } as any,
    );
    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("in_progress");
  });

  it("keeps an item in Needs me when the operator says the app is right that it needs them", async () => {
    graph.upsertWorkItem({ id: "OPS-5", source: "jira", title: "Five", currentAtcStatus: "blocked_on_human", statusAt: "2026-10-14T09:00:00.000Z" });
    graph.upsertThread({ id: "T-FIVE", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-5" });
    graph.linkThreadWorkItem("T-FIVE", "OPS-5", "primary");
    graph.insertEvent({ threadId: "T-FIVE", messageId: "f1", workItemId: "OPS-5", agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, rawText: "Need your approval", timestamp: "2026-10-14T09:00:00.000Z", targetedAtOperator: true });
    const eventId = graph.getEventByMessageId("d1", "T-DIGEST")!.id;
    graph.recordDigestCheck({ eventId, workItemId: "OPS-5", digestStatus: "completed", digestTargeted: false, itemStatus: "blocked_on_human", at: DIGEST_AT });
    graph.markDigestCheckUnsure(eventId, "OPS-5", "unclear");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-5"]);

    await decide({ eventId, workItemId: "OPS-5", verdict: "app" });

    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-5"]);
  });

  it("brings a dismissed item back when the operator agrees the digest says it needs them", async () => {
    const eventId = waiting("OPS-2", "in_progress", "blocked_on_human", true);
    graph.dismissWorkItem("OPS-2");

    await decide({ eventId, workItemId: "OPS-2", verdict: "digest" });

    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-2"]);
  });

  it("leaves an item out of Needs me when the operator agrees it's blocked on someone else", async () => {
    const eventId = waiting("OPS-2", "in_progress", "blocked_on_human", false);

    await decide({ eventId, workItemId: "OPS-2", verdict: "digest" });

    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems()).toEqual([]);
  });

  it("doesn't let dismissing a whole-digest claim silence a later one from the item's own line", async () => {
    const eventId = waiting("OPS-4", "in_progress", "blocked_on_human", false, false);
    await decide({ eventId, workItemId: "OPS-4", verdict: "app" });

    graph.insertEvent({ threadId: "T-DIGEST", messageId: "d3", workItemId: null, agentId: "U-atlas", status: "in_progress", confidence: 0.9, rawText: "OPS-4 blocked on Dana", timestamp: "2026-10-16T09:00:00.000Z", digest: true });
    graph.recordDigestCheck({ eventId: graph.getEventByMessageId("d3", "T-DIGEST")!.id, workItemId: "OPS-4", digestStatus: "blocked_on_human", digestTargeted: false, itemStatus: "in_progress", at: "2026-10-16T09:00:00.000Z", fromLine: true });

    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks WHERE work_item_id = 'OPS-4'").get()).toEqual({ n: 2 });
  });

  it("doesn't ask the same sender's same claim again once the operator says the app is right", async () => {
    const eventId = waiting("OPS-1", "blocked_on_human", "completed");
    await decide({ eventId, workItemId: "OPS-1", verdict: "app" });

    graph.insertEvent({ threadId: "T-DIGEST", messageId: "d2", workItemId: null, agentId: "U-atlas", status: "in_progress", confidence: 0.9, rawText: "Daily again", timestamp: "2026-10-16T09:00:00.000Z", digest: true });
    graph.recordDigestCheck({ eventId: graph.getEventByMessageId("d2", "T-DIGEST")!.id, workItemId: "OPS-1", digestStatus: "completed", digestTargeted: false, itemStatus: "blocked_on_human", at: "2026-10-16T09:00:00.000Z" });

    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks WHERE work_item_id = 'OPS-1'").get()).toEqual({ n: 1 });
    // The judge's note is kept
    expect(db.db.prepare("SELECT judge_reason FROM digest_checks WHERE work_item_id = 'OPS-1'").get()).toEqual({ judge_reason: "The messages don't settle it" });
  });

  it("doesn't apply a decision to an item that has moved on, or that's gone", async () => {
    const moved = waiting("OPS-1", "blocked_on_human", "completed");
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", currentAtcStatus: "blocked_on_human", statusAt: "2026-10-15T10:00:00.000Z" });
    expect((await decide({ eventId: moved, workItemId: "OPS-1", verdict: "digest" })).status).toBe(409);
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");

    const merged = waiting("OPS-3", "blocked_on_human", "completed");
    db.db.prepare("UPDATE work_items SET merged_into = 'OPS-1' WHERE id = 'OPS-3'").run();
    expect((await decide({ eventId: merged, workItemId: "OPS-3", verdict: "digest" })).status).toBe(409);
  });

  it("doesn't show a claim that was the whole digest's status, not its line about this item: it can only be dismissed", async () => {
    const eventId = waiting("OPS-1", "noise", "blocked_on_human", false, false);
    expect((await (await get()).json()).items).toEqual([]);

    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "digest" })).status).toBe(404);
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("noise");
  });

  it("shows a digest that asks for the operator with no line saying what for once, and only lets it be dismissed", async () => {
    const eventId = waiting("OPS-1", "noise", "blocked_on_human", true, false);
    waiting("OPS-3", "noise", "blocked_on_human", true, false);

    const items = (await (await get()).json()).items;
    expect(items.map((i: { workItemId: string; aboutThisItem: boolean }) => [i.workItemId, i.aboutThisItem])).toEqual([["OPS-1", false]]);
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "digest" })).status).toBe(409);
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "app" })).status).toBe(200);
  });

  it("keeps a snooze, reopens a finished item the operator agrees needs them, and refuses a non-JSON body", async () => {
    const snoozed = new Date(Date.now() + 3600_000).toISOString();
    const eventId = waiting("OPS-2", "completed", "blocked_on_human");
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", snoozedUntil: snoozed });

    await decide({ eventId, workItemId: "OPS-2", verdict: "digest" });

    expect(graph.getWorkItemById("OPS-2")).toMatchObject({ currentAtcStatus: "blocked_on_human", snoozedUntil: snoozed });
    expect(graph.getWorkItemById("OPS-2")!.reopenedAt).not.toBeNull();
    const bad = await createApp(makeState()).request("/api/digest-checks/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
    expect(bad.status).toBe(400);
  });
});
