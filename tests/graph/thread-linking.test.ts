import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("Thread Linking", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    // Seed a work item and two threads
    graph.upsertWorkItem({ id: "AI-100", source: "extracted", title: "Test work item" });
    graph.upsertThread({
      id: "t-1", channelId: "C-1", channelName: "general",
      platform: "slack", lastActivity: "2026-04-01T10:00:00.000Z",
    });
    graph.upsertThread({
      id: "t-2", channelId: "C-2", channelName: "dev",
      platform: "slack", lastActivity: "2026-04-02T10:00:00.000Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("linkThread", () => {
    it("sets work_item_id and manually_linked on the thread", () => {
      graph.linkThread("t-1", "AI-100");

      const thread = graph.getThreadById("t-1");
      expect(thread).not.toBeNull();
      expect(thread!.workItemId).toBe("AI-100");
      expect(thread!.manuallyLinked).toBe(true);
    });

    it("overwrites an existing auto-linked work item", () => {
      // Auto-link t-1 to a different work item
      graph.upsertWorkItem({ id: "AI-200", source: "extracted", title: "Other" });
      graph.upsertThread({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "AI-200",
      });

      // Manually link to AI-100
      graph.linkThread("t-1", "AI-100");

      const thread = graph.getThreadById("t-1");
      expect(thread!.workItemId).toBe("AI-100");
      expect(thread!.manuallyLinked).toBe(true);
    });
  });

  describe("unlinkThread", () => {
    it("clears work_item_id and resets manually_linked", () => {
      graph.linkThread("t-1", "AI-100");
      graph.unlinkThread("t-1");

      const thread = graph.getThreadById("t-1");
      expect(thread!.workItemId).toBeNull();
      expect(thread!.manuallyLinked).toBe(false);
    });
  });

  describe("getUnlinkedThreads", () => {
    it("returns threads with no work item", () => {
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked).toHaveLength(2);
    });

    it("excludes manually linked threads", () => {
      graph.linkThread("t-1", "AI-100");
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0].id).toBe("t-2");
    });

    it("includes threads with synthetic thread: work items", () => {
      graph.upsertWorkItem({ id: "thread:t-1", source: "inferred", title: "Untitled" });
      graph.upsertThread({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "thread:t-1",
      });

      const unlinked = graph.getUnlinkedThreads(20);
      // t-1 should still appear as "unlinked" since it only has a synthetic ID
      expect(unlinked.some((t) => t.id === "t-1")).toBe(true);
    });

    it("respects the limit parameter", () => {
      const unlinked = graph.getUnlinkedThreads(1);
      expect(unlinked).toHaveLength(1);
    });

    it("filters by channel name when query is provided", () => {
      const unlinked = graph.getUnlinkedThreads(20, "dev");
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0].channelName).toBe("dev");
    });

    it("returns results ordered by last_activity DESC", () => {
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked[0].id).toBe("t-2"); // more recent
      expect(unlinked[1].id).toBe("t-1");
    });
  });
});
