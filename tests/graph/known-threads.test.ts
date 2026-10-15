import { describe, it, expect } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("getKnownThreads", () => {
  it("gives the latest platform message processed, and how many, per recent thread, ignoring operator actions", () => {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertThread({ id: "T1", channelId: "C1", platform: "slack", lastActivity: "2026-10-15T09:00:00.000Z" });
    graph.upsertThread({ id: "OLD", channelId: "C1", platform: "slack", lastActivity: "2026-10-01T09:00:00.000Z" });
    const event = (threadId: string, messageId: string, timestamp: string) =>
      graph.insertEvent({ threadId, messageId, workItemId: null, agentId: null, status: "in_progress", confidence: 0.9, reason: "r", rawText: "x", timestamp });
    event("T1", "1792227600.000100", "2026-10-15T08:00:00.000Z");
    event("T1", "1792231200.000100", "2026-10-15T09:00:00.000Z");
    // Stamped with the click time: a reply posted just before it hasn't been read yet
    event("T1", "operator-dismiss-1792231300000", "2026-10-15T09:01:40.000Z");
    event("OLD", "1790845200.000100", "2026-10-01T09:00:00.000Z");

    expect([...graph.getKnownThreads("2026-10-12T00:00:00.000Z")]).toEqual([["T1", { latestAt: "2026-10-15T09:00:00.000Z", messageCount: 2 }]]);
    db.close();
  });
});
