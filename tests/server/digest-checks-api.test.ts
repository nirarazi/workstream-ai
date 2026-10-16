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
function waiting(id: string, itemStatus: StatusCategory, digestStatus: StatusCategory, targeted = false): string {
  graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: itemStatus, statusAt: "2026-10-14T09:00:00.000Z" });
  const eventId = graph.getEventByMessageId("d1", "T-DIGEST")!.id;
  graph.recordDigestCheck({ eventId, workItemId: id, digestStatus, digestTargeted: targeted, itemStatus, at: DIGEST_AT });
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
    waiting("OPS-1", "in_progress", "completed");
    waiting("OPS-3", "in_progress", "completed");
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", currentAtcStatus: "in_progress", statusAt: "2026-10-15T10:00:00.000Z" }); // moved on

    const body = await (await get()).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      workItemId: "OPS-1", title: "Item OPS-1", appStatus: "in_progress", digestStatus: "completed",
      sender: "Atlas", judgeNote: "The messages don't settle it", digestText: "Daily: OPS-1 done, OPS-2 blocked on Alex, OPS-3 moving",
    });
  });

  it("keeps the app's view when the operator says so", async () => {
    const eventId = waiting("OPS-1", "in_progress", "completed");

    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "app" })).status).toBe(200);

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("in_progress");
    expect((await (await get()).json()).items).toEqual([]);
  });

  it("takes the digest's view when the operator says so, whatever it is", async () => {
    const eventId = waiting("OPS-1", "in_progress", "completed");

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
    const eventId = waiting("OPS-1", "in_progress", "completed");
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "maybe" })).status).toBe(400);
    expect((await decide({ eventId, workItemId: "OPS-9", verdict: "app" })).status).toBe(404);
    await decide({ eventId, workItemId: "OPS-1", verdict: "app" });
    expect((await decide({ eventId, workItemId: "OPS-1", verdict: "digest" })).status).toBe(404);
  });
});
