// tests/actions/actions.test.ts — ActionHandler unit tests

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { ActionHandler } from "../../core/actions.js";
import type { PlatformAdapter } from "../../core/adapters/platforms/interface.js";

function createMockAdapter(overrides?: Partial<PlatformAdapter>): PlatformAdapter {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    readThreads: vi.fn().mockResolvedValue([]),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    streamMessages: vi.fn(),
    getUsers: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  };
}

describe("ActionHandler", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedWorkItem(id = "AI-100") {
    graph.upsertWorkItem({
      id,
      source: "jira",
      title: "Test work item",
      currentAtcStatus: "blocked_on_human",
    });
  }

  function seedThread(workItemId = "AI-100", threadId = "T001", channelId = "C001") {
    graph.upsertThread({
      id: threadId,
      channelId,
      channelName: "agent-orchestrator",
      platform: "slack",
      workItemId,
    });
  }

  describe("work item not found", () => {
    it("returns error when work item does not exist", async () => {
      const handler = new ActionHandler(graph);
      const result = await handler.execute("NONEXISTENT", "approve");
      expect(result).toEqual({ ok: false, error: "Work item not found" });
    });
  });

  describe("approve", () => {
    it("updates status to completed and sends message", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      const result = await handler.execute("AI-100", "approve", "Looks good");
      expect(result).toEqual({ ok: true });

      const updated = graph.getWorkItemById("AI-100");
      expect(updated?.currentAtcStatus).toBe("completed");

      expect(adapter.replyToThread).toHaveBeenCalledWith(
        "T001",
        "C001",
        "✅ Approved. Looks good",
      );
    });

    it("works without a platform adapter", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      const result = await handler.execute("AI-100", "approve");
      expect(result).toEqual({ ok: true });
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("completed");
    });

    it("works without a thread", async () => {
      seedWorkItem();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      const result = await handler.execute("AI-100", "approve");
      expect(result).toEqual({ ok: true });
      expect(adapter.replyToThread).not.toHaveBeenCalled();
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("completed");
    });

    it("sends default message when no custom message provided", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      await handler.execute("AI-100", "approve");
      expect(adapter.replyToThread).toHaveBeenCalledWith("T001", "C001", "✅ Approved.");
    });

    it("still updates graph when platform adapter fails", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter({
        replyToThread: vi.fn().mockRejectedValue(new Error("Slack API error")),
      });
      const handler = new ActionHandler(graph, adapter);

      const result = await handler.execute("AI-100", "approve");
      expect(result).toEqual({ ok: true });
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("completed");
    });
  });

  describe("redirect", () => {
    it("sends message but does not change status", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      const result = await handler.execute("AI-100", "redirect", "Try agent Byte instead");
      expect(result).toEqual({ ok: true });

      expect(adapter.replyToThread).toHaveBeenCalledWith(
        "T001",
        "C001",
        "↩️ Redirecting. Try agent Byte instead",
      );

      // Status should remain unchanged
      const updated = graph.getWorkItemById("AI-100");
      expect(updated?.currentAtcStatus).toBe("blocked_on_human");
    });

    it("works without platform adapter or thread", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      const result = await handler.execute("AI-100", "redirect");
      expect(result).toEqual({ ok: true });
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("blocked_on_human");
    });
  });

  describe("close", () => {
    it("updates status to completed and sends message", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      const result = await handler.execute("AI-100", "close", "No longer needed");
      expect(result).toEqual({ ok: true });

      expect(adapter.replyToThread).toHaveBeenCalledWith(
        "T001",
        "C001",
        "🔒 Closed. No longer needed",
      );

      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("completed");
    });

    it("works without platform adapter", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      const result = await handler.execute("AI-100", "close");
      expect(result).toEqual({ ok: true });
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("completed");
    });
  });

  describe("snooze", () => {
    it("sets snoozedUntil with default 60 minutes", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      const before = Date.now();
      const result = await handler.execute("AI-100", "snooze");
      const after = Date.now();

      expect(result).toEqual({ ok: true });

      const updated = graph.getWorkItemById("AI-100");
      expect(updated?.snoozedUntil).toBeTruthy();

      const snoozedTime = new Date(updated!.snoozedUntil!).getTime();
      // Should be ~60 minutes from now
      expect(snoozedTime).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
      expect(snoozedTime).toBeLessThanOrEqual(after + 61 * 60 * 1000);
    });

    it("uses custom snooze duration", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      const before = Date.now();
      const result = await handler.execute("AI-100", "snooze", undefined, 30);
      const after = Date.now();

      expect(result).toEqual({ ok: true });

      const updated = graph.getWorkItemById("AI-100");
      const snoozedTime = new Date(updated!.snoozedUntil!).getTime();
      expect(snoozedTime).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
      expect(snoozedTime).toBeLessThanOrEqual(after + 31 * 60 * 1000);
    });

    it("does not send a thread message", async () => {
      seedWorkItem();
      seedThread();
      const adapter = createMockAdapter();
      const handler = new ActionHandler(graph, adapter);

      await handler.execute("AI-100", "snooze");
      expect(adapter.replyToThread).not.toHaveBeenCalled();
    });

    it("preserves existing status", async () => {
      seedWorkItem();
      const handler = new ActionHandler(graph);

      await handler.execute("AI-100", "snooze");
      expect(graph.getWorkItemById("AI-100")?.currentAtcStatus).toBe("blocked_on_human");
    });
  });
});
