// tests/graph/pin.test.ts — Tests for pin and dismiss functionality on work items

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("pin and dismiss", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    // Seed a work item
    graph.upsertWorkItem({
      id: "AI-100",
      source: "jira",
      title: "Test item",
      currentAtcStatus: "blocked_on_human",
    });
    // Seed agent first (events reference agents via FK)
    graph.upsertAgent({
      id: "agent-1",
      name: "ByteAgent",
      platform: "slack",
      platformUserId: "U001",
    });
    // Seed a thread and event so getActionableItems can find it
    graph.upsertThread({
      id: "T001",
      channelId: "C001",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-100",
    });
    graph.insertEvent({
      threadId: "T001",
      messageId: "msg-1",
      workItemId: "AI-100",
      agentId: "agent-1",
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "blocked",
      rawText: "I need help",
      timestamp: new Date().toISOString(),
      entryType: "block",
      targetedAtOperator: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("togglePin", () => {
    it("pins an unpinned work item", () => {
      const result = graph.togglePin("AI-100");
      expect(result).toBe(true);
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.pinned).toBe(true);
    });

    it("unpins a pinned work item", () => {
      graph.togglePin("AI-100");
      const result = graph.togglePin("AI-100");
      expect(result).toBe(false);
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.pinned).toBe(false);
    });

    it("returns false for non-existent work item", () => {
      const result = graph.togglePin("NONEXISTENT");
      expect(result).toBe(false);
    });
  });

  describe("dismissWorkItem", () => {
    it("sets dismissed_at timestamp", () => {
      graph.dismissWorkItem("AI-100");
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.dismissedAt).not.toBeNull();
    });

    it("excludes dismissed items from getActionableItems", () => {
      const before = graph.getActionableItems();
      expect(before.length).toBe(1);

      graph.dismissWorkItem("AI-100");

      const after = graph.getActionableItems();
      expect(after.length).toBe(0);
    });

    it("re-includes item when new blocking event arrives after dismiss", () => {
      graph.dismissWorkItem("AI-100");
      expect(graph.getActionableItems().length).toBe(0);

      // New blocking event with timestamp after dismissed_at
      graph.insertEvent({
        threadId: "T001",
        messageId: "msg-2",
        workItemId: "AI-100",
        agentId: "agent-1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "blocked again",
        rawText: "Still need help",
        timestamp: new Date(Date.now() + 1000).toISOString(),
        entryType: "block",
        targetedAtOperator: true,
      });

      const after = graph.getActionableItems();
      expect(after.length).toBe(1);
    });
  });

  describe("pinned items in getActionableItems", () => {
    it("returns pinned field on actionable items", () => {
      graph.togglePin("AI-100");
      const items = graph.getActionableItems();
      expect(items[0].workItem.pinned).toBe(true);
    });
  });
});
