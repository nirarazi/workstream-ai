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

    it("has entry_type column on events table", () => {
      const cols = db.db.pragma("table_info(events)") as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "entry_type")).toBe(true);
    });

    it("adds targeted_at_operator column to events table", () => {
      const cols = db.db.pragma("table_info(events)") as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "targeted_at_operator")).toBe(true);
    });

    it("migrates agents table to include is_bot column", () => {
      const cols = db.db.pragma("table_info(agents)") as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "is_bot")).toBe(true);
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

    it("getActionableItems finds events linked via thread work_item_id", () => {
      // Create a work item
      graph.upsertWorkItem({
        id: "WI-THREAD",
        source: "inferred",
        title: "Thread-linked item",
        currentAtcStatus: "blocked_on_human",
        currentConfidence: 0.9,
      });

      // Create a thread linked to this work item
      graph.upsertThread({
        id: "thread-linked-1",
        channelId: "C001",
        channelName: "general",
        platform: "slack",
        workItemId: "WI-THREAD",
        lastActivity: new Date().toISOString(),
        messageCount: 1,
      });

      // Create an agent
      graph.upsertAgent({
        id: "agent-1",
        name: "Byte",
        platform: "slack",
        platformUserId: "U001",
      });

      // Insert event linked via thread (event.work_item_id is NULL, but thread.work_item_id = "WI-THREAD")
      graph.insertEvent({
        threadId: "thread-linked-1",
        messageId: "msg-via-thread",
        workItemId: null,  // NOT directly tagged
        agentId: "agent-1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "Blocked",
        rawText: "I'm blocked",
        timestamp: new Date().toISOString(),
        targetedAtOperator: true,
      });

      const items = graph.getActionableItems();
      const found = items.find((i) => i.workItem.id === "WI-THREAD");
      expect(found).toBeDefined();
      expect(found!.latestEvent.rawText).toBe("I'm blocked");
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

  describe("getFleetItems", () => {
    it("returns all non-completed work items with latest event and agent", () => {
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
      graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Active task", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Done task", currentAtcStatus: "completed" });
      graph.upsertWorkItem({ id: "AI-3", source: "jira", title: "Blocked task", currentAtcStatus: "blocked_on_human" });

      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
      graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-3" });

      graph.insertEvent({ threadId: "t1", messageId: "m1", workItemId: "AI-1", agentId: "a1", status: "in_progress", confidence: 0.9, timestamp: "2026-04-01T08:00:00Z" });
      graph.insertEvent({ threadId: "t2", messageId: "m2", workItemId: "AI-2", agentId: "a1", status: "completed", confidence: 0.95, timestamp: "2026-04-01T09:00:00Z" });
      graph.insertEvent({ threadId: "t3", messageId: "m3", workItemId: "AI-3", agentId: "a1", status: "blocked_on_human", confidence: 0.9, timestamp: "2026-04-01T10:00:00Z" });

      const items = graph.getFleetItems();

      // Should exclude completed
      expect(items).toHaveLength(2);
      const ids = items.map((i) => i.workItem.id);
      expect(ids).toContain("AI-1");
      expect(ids).toContain("AI-3");
      expect(ids).not.toContain("AI-2");
    });

    it("returns items with no events (newly created work items)", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "New task", currentAtcStatus: "in_progress" });

      const items = graph.getFleetItems();
      expect(items).toHaveLength(1);
      expect(items[0].workItem.id).toBe("AI-1");
    });
  });

  describe("getRecentItems", () => {
    it("returns most recently updated items, excluding completed and noise", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira", currentAtcStatus: "completed" });
      graph.upsertWorkItem({ id: "AI-2", source: "jira", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-3", source: "jira", currentAtcStatus: "blocked_on_human" });

      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
      graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-3" });

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
      graph.insertEvent({
        threadId: "t3",
        messageId: "m3",
        workItemId: "AI-3",
        status: "blocked_on_human",
        confidence: 0.9,
        timestamp: "2026-03-31T12:00:00Z",
      });

      const items = graph.getRecentItems(10);
      // completed items are excluded from the Stream
      expect(items).toHaveLength(2);
      const ids = items.map((i) => i.workItem.id);
      expect(ids).not.toContain("AI-1");
      expect(ids).toContain("AI-2");
      expect(ids).toContain("AI-3");
    });

    it("respects the limit", () => {
      for (let i = 0; i < 5; i++) {
        graph.upsertWorkItem({ id: `WI-${i}`, source: "test" });
      }

      const items = graph.getRecentItems(3);
      expect(items).toHaveLength(3);
    });
  });

  describe("sidekick query methods", () => {
    beforeEach(() => {
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
      graph.upsertAgent({ id: "a2", name: "Pixel", platform: "slack", platformUserId: "U2" });

      graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login bug", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-200", source: "jira", title: "Add dark mode", currentAtcStatus: "blocked_on_human" });
      graph.upsertWorkItem({ id: "AI-300", source: "jira", title: "Update API docs", currentAtcStatus: "completed" });

      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-200" });
      graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-300" });

      graph.insertEvent({
        threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
        status: "in_progress", confidence: 0.9, rawText: "Working on login fix",
        timestamp: "2026-04-01T08:00:00Z",
      });
      graph.insertEvent({
        threadId: "t2", messageId: "m2", workItemId: "AI-200", agentId: "a2",
        status: "blocked_on_human", confidence: 0.95, rawText: "Need approval for design",
        timestamp: "2026-04-01T09:00:00Z",
      });
      graph.insertEvent({
        threadId: "t3", messageId: "m3", workItemId: "AI-300", agentId: "a1",
        status: "completed", confidence: 0.9, rawText: "Docs updated",
        timestamp: "2026-04-01T10:00:00Z",
      });
    });

    it("searchWorkItems finds by ID", () => {
      const results = graph.searchWorkItems("AI-100");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("AI-100");
    });

    it("searchWorkItems finds by title substring", () => {
      const results = graph.searchWorkItems("login");
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain("login");
    });

    it("searchWorkItems returns empty for no match", () => {
      const results = graph.searchWorkItems("nonexistent");
      expect(results).toHaveLength(0);
    });

    it("getWorkItemsByAgent returns items for a specific agent", () => {
      const results = graph.getWorkItemsByAgent("a1");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const ids = results.map((r) => r.id);
      expect(ids).toContain("AI-100");
    });

    it("getEventsSince returns events after a date", () => {
      const since = new Date("2026-04-01T08:30:00Z");
      const results = graph.getEventsSince(since);
      expect(results).toHaveLength(2); // m2 and m3
      expect(results[0].timestamp >= since.toISOString()).toBe(true);
    });

    it("getAgentByName finds by case-insensitive name", () => {
      const agent = graph.getAgentByName("byte");
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("Byte");
    });

    it("getAgentByName returns null for unknown name", () => {
      const agent = graph.getAgentByName("UnknownBot");
      expect(agent).toBeNull();
    });

    it("getFleetStats returns aggregate counts by status", () => {
      const stats = graph.getFleetStats();
      expect(stats.in_progress).toBe(1);
      expect(stats.blocked_on_human).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.total).toBe(3);
    });
  });

  describe("getOpenWorkItemSummaries", () => {
    it("returns non-completed, non-noise work items with id and title", () => {
      graph.upsertWorkItem({ id: "AI-100", source: "extracted", title: "Fix login bug", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-101", source: "extracted", title: "Deploy staging", currentAtcStatus: "completed" });
      graph.upsertWorkItem({ id: "thread:abc.123", source: "inferred", title: "Missing API key", currentAtcStatus: "blocked_on_human" });
      graph.upsertWorkItem({ id: "AI-102", source: "extracted", title: "Noisy alert", currentAtcStatus: "noise" });
      graph.upsertWorkItem({ id: "AI-103", source: "extracted", title: "No status yet" });

      const summaries = graph.getOpenWorkItemSummaries();

      // Should include in_progress, blocked_on_human, needs_decision, and null-status items
      // Should exclude completed and noise
      expect(summaries).toHaveLength(3);
      expect(summaries.map(s => s.id)).toContain("AI-100");
      expect(summaries.map(s => s.id)).toContain("thread:abc.123");
      expect(summaries.map(s => s.id)).toContain("AI-103");
      expect(summaries.map(s => s.id)).not.toContain("AI-101");
      expect(summaries.map(s => s.id)).not.toContain("AI-102");

      // Each summary has id and title
      const ai100 = summaries.find(s => s.id === "AI-100")!;
      expect(ai100.title).toBe("Fix login bug");
    });

    it("limits results to 100 items", () => {
      for (let i = 0; i < 120; i++) {
        graph.upsertWorkItem({ id: `WI-${i}`, source: "extracted", title: `Item ${i}`, currentAtcStatus: "in_progress" });
      }
      const summaries = graph.getOpenWorkItemSummaries();
      expect(summaries.length).toBeLessThanOrEqual(100);
    });
  });

  describe("Event actionRequiredFrom and nextAction persistence", () => {
    let db: Database;
    let graph: ContextGraph;

    beforeEach(() => {
      db = new Database(":memory:");
      graph = new ContextGraph(db);
    });

    afterEach(() => {
      db.close();
    });

    it("persists and retrieves actionRequiredFrom and nextAction", () => {
      graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Test" });
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });

      const event = graph.insertEvent({
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-1",
        agentId: "a1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "Needs approval",
        rawText: "Please approve PR #716",
        timestamp: new Date().toISOString(),
        targetedAtOperator: true,
        actionRequiredFrom: ["U_GUY123", "U_OPERATOR"],
        nextAction: "Review and approve PR #716",
      });

      expect(event.actionRequiredFrom).toEqual(["U_GUY123", "U_OPERATOR"]);
      expect(event.nextAction).toBe("Review and approve PR #716");
    });

    it("defaults actionRequiredFrom and nextAction to null when not provided", () => {
      graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Test2" });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });

      const event = graph.insertEvent({
        threadId: "t2",
        messageId: "m2",
        workItemId: "AI-2",
        agentId: "a1",
        status: "in_progress",
        confidence: 0.8,
        reason: "Working on it",
        timestamp: new Date().toISOString(),
      });

      expect(event.actionRequiredFrom).toBeNull();
      expect(event.nextAction).toBeNull();
    });
  });

  describe("findCandidateWorkItems", () => {
    function setupGraphData() {
      // Create agents
      graph.upsertAgent({ id: "byte", name: "Byte", platform: "slack", platformUserId: "byte" });
      graph.upsertAgent({ id: "pixel", name: "Pixel", platform: "slack", platformUserId: "pixel" });

      // Create work items
      graph.upsertWorkItem({ id: "AI-100", source: "extracted", title: "Deploy payment service to staging", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-200", source: "extracted", title: "Refactor auth middleware", currentAtcStatus: "in_progress" });
      graph.upsertWorkItem({ id: "AI-300", source: "extracted", title: "Fix login bug", currentAtcStatus: "completed" });

      // Create threads in channel C-1
      graph.upsertThread({ id: "t-1", channelId: "C-1", channelName: "#dev", platform: "slack", workItemId: "AI-100", lastActivity: new Date().toISOString(), messageCount: 1 });
      graph.upsertThread({ id: "t-2", channelId: "C-1", channelName: "#dev", platform: "slack", workItemId: "AI-200", lastActivity: new Date().toISOString(), messageCount: 1 });
      graph.upsertThread({ id: "t-3", channelId: "C-2", channelName: "#ops", platform: "slack", workItemId: "AI-300", lastActivity: new Date().toISOString(), messageCount: 1 });

      // Create events — Byte worked on AI-100, Pixel worked on AI-200
      graph.insertEvent({ threadId: "t-1", messageId: "m-1", workItemId: "AI-100", agentId: "byte", status: "in_progress", confidence: 0.9, reason: "Working", rawText: "Deploying payment service", timestamp: new Date().toISOString() });
      graph.insertEvent({ threadId: "t-2", messageId: "m-2", workItemId: "AI-200", agentId: "pixel", status: "in_progress", confidence: 0.9, reason: "Working", rawText: "Refactoring auth", timestamp: new Date().toISOString() });
    }

    it("ranks same-agent work items highest", () => {
      setupGraphData();

      const candidates = graph.findCandidateWorkItems({
        agentId: "byte",
        channelId: "C-1",
        messageText: "still working on the service",
      });

      // AI-100 should rank highest — same agent (Byte) + same channel
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].id).toBe("AI-100");
      expect(candidates[0].reasons).toContain("same agent");
    });

    it("excludes completed work items", () => {
      setupGraphData();

      const candidates = graph.findCandidateWorkItems({
        agentId: "byte",
        channelId: "C-2",
        messageText: "the login bug",
      });

      const ids = candidates.map(c => c.id);
      expect(ids).not.toContain("AI-300"); // completed
    });

    it("returns empty when no signals match", () => {
      setupGraphData();

      const candidates = graph.findCandidateWorkItems({
        agentId: "unknown-agent",
        channelId: "C-unknown",
        messageText: "something completely unrelated",
      });

      expect(candidates).toEqual([]);
    });

    it("includes keyword overlap in reasons", () => {
      setupGraphData();

      const candidates = graph.findCandidateWorkItems({
        agentId: "pixel",
        channelId: "C-1",
        messageText: "the auth middleware refactoring is going well",
      });

      // AI-200 should match on agent + keywords
      const ai200 = candidates.find(c => c.id === "AI-200");
      expect(ai200).toBeDefined();
      expect(ai200!.reasons.some(r => r.includes("keyword overlap"))).toBe(true);
    });

    it("respects score threshold", () => {
      setupGraphData();

      // With a very high threshold, nothing should match
      const candidates = graph.findCandidateWorkItems({
        agentId: "byte",
        channelId: "C-1",
        messageText: "hello",
        scoreThreshold: 100,
      });

      expect(candidates).toEqual([]);
    });
  });

  describe("computeBotTypes", () => {
    it("classifies templated one-way bots as notification", () => {
      // Create a notification bot: posts the same template, always starts threads, no conversations
      graph.upsertAgent({ id: "B-crm", name: "CRM Bot", platform: "slack", platformUserId: "B-crm", isBot: true });
      graph.upsertWorkItem({ id: "thread:t1", source: "inferred", title: "Lead 1" });
      graph.upsertWorkItem({ id: "thread:t2", source: "inferred", title: "Lead 2" });
      graph.upsertWorkItem({ id: "thread:t3", source: "inferred", title: "Lead 3" });

      for (let i = 1; i <= 3; i++) {
        graph.upsertThread({ id: `t${i}`, channelId: "C-leads", channelName: "#leads", platform: "slack", workItemId: `thread:t${i}`, lastActivity: new Date().toISOString(), messageCount: 1 });
        graph.insertEvent({ threadId: `t${i}`, messageId: `m-crm-${i}`, workItemId: `thread:t${i}`, agentId: "B-crm", status: "blocked_on_human", confidence: 0.8, reason: "Lead alert", rawText: "*Alert: New lead determination*\n*QUOTE:* Q12345", timestamp: new Date().toISOString() });
      }

      graph.computeBotTypes();

      expect(graph.getBotType("B-crm")).toBe("notification");
    });

    it("classifies conversational bots as agent", () => {
      // Create an AI agent bot: varied messages, participates in threads with others
      graph.upsertAgent({ id: "U-levy", name: "Levy", platform: "slack", platformUserId: "U-levy", isBot: true });
      graph.upsertAgent({ id: "U-human", name: "Nir", platform: "slack", platformUserId: "U-human", isBot: false });
      graph.upsertWorkItem({ id: "AI-100", source: "extracted", title: "Deployment task" });

      graph.upsertThread({ id: "t-conv1", channelId: "C-ops", channelName: "#ops", platform: "slack", workItemId: "AI-100", lastActivity: new Date().toISOString(), messageCount: 3 });
      // Levy starts a thread
      graph.insertEvent({ threadId: "t-conv1", messageId: "m-levy-1", workItemId: "AI-100", agentId: "U-levy", status: "in_progress", confidence: 0.9, reason: "Working", rawText: "Starting deployment of AI-100", timestamp: new Date().toISOString() });
      // Human replies
      graph.insertEvent({ threadId: "t-conv1", messageId: "m-human-1", workItemId: "AI-100", agentId: "U-human", status: "noise", confidence: 0.9, reason: "Ack", rawText: "Sounds good, proceed", timestamp: new Date().toISOString() });
      // Levy responds
      graph.insertEvent({ threadId: "t-conv1", messageId: "m-levy-2", workItemId: "AI-100", agentId: "U-levy", status: "in_progress", confidence: 0.9, reason: "Continuing", rawText: "Deployment 60% complete, running migrations", timestamp: new Date().toISOString() });

      graph.computeBotTypes();

      expect(graph.getBotType("U-levy")).toBe("agent");
    });

    it("requires minimum 2 events before classifying", () => {
      graph.upsertAgent({ id: "B-new", name: "New Bot", platform: "slack", platformUserId: "B-new", isBot: true });
      graph.upsertWorkItem({ id: "thread:t-single", source: "inferred", title: "Single post" });
      graph.upsertThread({ id: "t-single", channelId: "C-1", channelName: "#test", platform: "slack", workItemId: "thread:t-single", lastActivity: new Date().toISOString(), messageCount: 1 });
      graph.insertEvent({ threadId: "t-single", messageId: "m-single", workItemId: "thread:t-single", agentId: "B-new", status: "noise", confidence: 0.5, reason: "First post", rawText: "Hello world", timestamp: new Date().toISOString() });

      graph.computeBotTypes();

      // Not enough data — should remain unclassified
      expect(graph.getBotType("B-new")).toBeNull();
    });
  });
});
