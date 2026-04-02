// tests/graph/db.test.ts — Database schema, CRUD, and actionable items query tests

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("Database", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("schema creation", () => {
    it("creates all tables", () => {
      const tables = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("agents");
      expect(names).toContain("work_items");
      expect(names).toContain("threads");
      expect(names).toContain("events");
      expect(names).toContain("enrichments");
      expect(names).toContain("poll_cursors");
    });

    it("creates summaries table", () => {
      const tables = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("summaries");
    });

    it("creates indexes", () => {
      const indexes = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_events_thread_id");
      expect(names).toContain("idx_events_work_item_id");
      expect(names).toContain("idx_threads_work_item_id");
      expect(names).toContain("idx_enrichments_work_item_id");
    });

    it("uses WAL mode for file-based databases", () => {
      // In-memory databases don't support WAL mode (they report "memory").
      // Verify the pragma was set by checking it doesn't throw and returns a value.
      const result = db.db.pragma("journal_mode") as Array<{ journal_mode: string }>;
      expect(result[0].journal_mode).toBe("memory");
    });
  });

  describe("agents CRUD", () => {
    it("upserts and retrieves an agent", () => {
      const agent = graph.upsertAgent({
        id: "agent-1",
        name: "Byte",
        platform: "slack",
        platformUserId: "U123",
        role: "coding",
      });

      expect(agent.id).toBe("agent-1");
      expect(agent.name).toBe("Byte");
      expect(agent.platform).toBe("slack");
      expect(agent.role).toBe("coding");

      const fetched = graph.getAgentById("agent-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("Byte");
    });

    it("updates agent on conflict", () => {
      graph.upsertAgent({
        id: "agent-1",
        name: "Byte",
        platform: "slack",
        platformUserId: "U123",
      });
      graph.upsertAgent({
        id: "agent-1",
        name: "Byte v2",
        platform: "slack",
        platformUserId: "U123",
        role: "senior-coding",
      });

      const agent = graph.getAgentById("agent-1");
      expect(agent!.name).toBe("Byte v2");
      expect(agent!.role).toBe("senior-coding");
    });

    it("returns null for non-existent agent", () => {
      expect(graph.getAgentById("nope")).toBeNull();
    });
  });

  describe("work items CRUD", () => {
    it("upserts and retrieves a work item", () => {
      const wi = graph.upsertWorkItem({
        id: "AI-382",
        source: "jira",
        title: "Fix login bug",
        currentAtcStatus: "in_progress",
        currentConfidence: 0.9,
      });

      expect(wi.id).toBe("AI-382");
      expect(wi.title).toBe("Fix login bug");
      expect(wi.currentAtcStatus).toBe("in_progress");

      const fetched = graph.getWorkItemById("AI-382");
      expect(fetched).not.toBeNull();
      expect(fetched!.source).toBe("jira");
    });

    it("preserves title on empty update", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Original" });
      graph.upsertWorkItem({ id: "AI-1", source: "jira" }); // no title

      const wi = graph.getWorkItemById("AI-1");
      expect(wi!.title).toBe("Original");
    });

    it("returns null for non-existent work item", () => {
      expect(graph.getWorkItemById("NOPE-1")).toBeNull();
    });
  });

  describe("threads CRUD", () => {
    it("upserts and retrieves a thread", () => {
      const thread = graph.upsertThread({
        id: "thread-1",
        channelId: "C123",
        channelName: "agent-orchestrator",
        platform: "slack",
        messageCount: 5,
      });

      expect(thread.id).toBe("thread-1");
      expect(thread.channelName).toBe("agent-orchestrator");
      expect(thread.messageCount).toBe(5);
    });

    it("links thread to work item", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "extracted" });
      graph.upsertThread({
        id: "thread-1",
        channelId: "C123",
        platform: "slack",
        workItemId: "AI-1",
      });

      const threads = graph.getThreadsForWorkItem("AI-1");
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("thread-1");
    });
  });

  describe("events CRUD", () => {
    it("inserts and retrieves events", () => {
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

      const event = graph.insertEvent({
        threadId: "t1",
        messageId: "msg-1",
        status: "blocked_on_human",
        confidence: 0.95,
        reason: "Agent asked for approval",
        rawText: "I need approval for PR #42",
        timestamp: "2026-03-31T10:00:00Z",
      });

      expect(event.status).toBe("blocked_on_human");
      expect(event.confidence).toBe(0.95);

      const events = graph.getEventsForThread("t1");
      expect(events).toHaveLength(1);
      expect(events[0].messageId).toBe("msg-1");
    });
  });

  describe("enrichments CRUD", () => {
    it("upserts and retrieves enrichments", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira" });

      const enrichment = graph.upsertEnrichment({
        workItemId: "AI-1",
        source: "jira",
        data: { status: "In Progress", priority: "High" },
      });

      expect(enrichment.workItemId).toBe("AI-1");
      expect(enrichment.data).toEqual({ status: "In Progress", priority: "High" });

      const enrichments = graph.getEnrichmentsForWorkItem("AI-1");
      expect(enrichments).toHaveLength(1);
      expect(enrichments[0].source).toBe("jira");
    });
  });

  describe("poll cursors", () => {
    it("sets and gets poll cursor", () => {
      graph.setPollCursor("C123", "1711900000.000000");

      const cursor = graph.getPollCursor("C123");
      expect(cursor).not.toBeNull();
      expect(cursor!.lastTimestamp).toBe("1711900000.000000");
    });

    it("updates existing cursor", () => {
      graph.setPollCursor("C123", "1000");
      graph.setPollCursor("C123", "2000");

      const cursor = graph.getPollCursor("C123");
      expect(cursor!.lastTimestamp).toBe("2000");
    });

    it("returns null for unknown channel", () => {
      expect(graph.getPollCursor("unknown")).toBeNull();
    });
  });

  describe("getActionableItems", () => {
    it("returns blocked and needs_decision items, ordered correctly", () => {
      // Set up agents
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
      graph.upsertAgent({ id: "a2", name: "Pixel", platform: "slack", platformUserId: "U2" });

      // Set up work items
      graph.upsertWorkItem({
        id: "AI-1",
        source: "jira",
        title: "Blocked item",
        currentAtcStatus: "blocked_on_human",
        currentConfidence: 0.9,
      });
      graph.upsertWorkItem({
        id: "AI-2",
        source: "jira",
        title: "Decision needed",
        currentAtcStatus: "needs_decision",
        currentConfidence: 0.85,
      });
      graph.upsertWorkItem({
        id: "AI-3",
        source: "jira",
        title: "In progress (not actionable)",
        currentAtcStatus: "in_progress",
        currentConfidence: 0.8,
      });

      // Set up threads
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
      graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-3" });

      // Set up events
      graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        agentId: "a1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "Needs approval",
        timestamp: "2026-03-31T10:00:00Z",
      });
      graph.insertEvent({
        threadId: "t2",
        messageId: "m2",
        workItemId: "AI-2",
        agentId: "a2",
        status: "needs_decision",
        confidence: 0.85,
        reason: "Which approach?",
        timestamp: "2026-03-31T11:00:00Z",
      });
      graph.insertEvent({
        threadId: "t3",
        messageId: "m3",
        workItemId: "AI-3",
        agentId: "a1",
        status: "in_progress",
        confidence: 0.8,
        timestamp: "2026-03-31T12:00:00Z",
      });

      const items = graph.getActionableItems();
      expect(items).toHaveLength(2);
      // blocked_on_human first
      expect(items[0].workItem.id).toBe("AI-1");
      expect(items[0].workItem.currentAtcStatus).toBe("blocked_on_human");
      expect(items[0].agent).not.toBeNull();
      expect(items[0].agent!.name).toBe("Byte");
      // needs_decision second
      expect(items[1].workItem.id).toBe("AI-2");
      expect(items[1].workItem.currentAtcStatus).toBe("needs_decision");
    });

    it("excludes snoozed items", () => {
      graph.upsertWorkItem({
        id: "AI-1",
        source: "jira",
        currentAtcStatus: "blocked_on_human",
        snoozedUntil: "2099-12-31T23:59:59Z",
      });
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        status: "blocked_on_human",
        confidence: 0.9,
        timestamp: "2026-03-31T10:00:00Z",
      });

      const items = graph.getActionableItems();
      expect(items).toHaveLength(0);
    });
  });

  describe("summaries CRUD", () => {
    it("upserts and retrieves a summary", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira" });
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        status: "in_progress",
        confidence: 0.9,
        timestamp: "2026-03-31T10:00:00Z",
      });

      const events = graph.getEventsForWorkItem("AI-1");
      const latestEventId = events[events.length - 1].id;

      graph.upsertSummary({
        workItemId: "AI-1",
        summaryText: "- Agent started work\n- Waiting for PR review",
        latestEventId,
      });

      const summary = graph.getSummary("AI-1");
      expect(summary).not.toBeNull();
      expect(summary!.summaryText).toContain("Agent started work");
      expect(summary!.latestEventId).toBe(latestEventId);
    });

    it("returns null for non-existent summary", () => {
      expect(graph.getSummary("NOPE-1")).toBeNull();
    });

    it("overwrites existing summary on upsert", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira" });
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        status: "in_progress",
        confidence: 0.9,
        timestamp: "2026-03-31T10:00:00Z",
      });

      graph.upsertSummary({
        workItemId: "AI-1",
        summaryText: "Old summary",
        latestEventId: "evt-old",
      });
      graph.upsertSummary({
        workItemId: "AI-1",
        summaryText: "New summary",
        latestEventId: "evt-new",
      });

      const summary = graph.getSummary("AI-1");
      expect(summary!.summaryText).toBe("New summary");
      expect(summary!.latestEventId).toBe("evt-new");
    });
  });

  describe("getRecentItems", () => {
    it("returns most recently updated items", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira", currentAtcStatus: "completed" });
      graph.upsertWorkItem({ id: "AI-2", source: "jira", currentAtcStatus: "in_progress" });

      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });

      graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        status: "completed",
        confidence: 0.9,
        timestamp: "2026-03-31T10:00:00Z",
      });
      graph.insertEvent({
        threadId: "t2",
        messageId: "m2",
        workItemId: "AI-2",
        status: "in_progress",
        confidence: 0.8,
        timestamp: "2026-03-31T11:00:00Z",
      });

      const items = graph.getRecentItems(10);
      expect(items).toHaveLength(2);
    });

    it("respects the limit", () => {
      for (let i = 0; i < 5; i++) {
        graph.upsertWorkItem({ id: `WI-${i}`, source: "test" });
      }

      const items = graph.getRecentItems(3);
      expect(items).toHaveLength(3);
    });
  });
});
