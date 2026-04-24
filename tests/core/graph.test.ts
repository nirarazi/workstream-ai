// tests/core/graph.test.ts — Tests for graph schema and merged_into support

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("merged_into column", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("work_items table has merged_into column", () => {
    const cols = db.db.pragma("table_info(work_items)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "merged_into")).toBe(true);
  });

  it("work items have a mergedInto field defaulting to null", () => {
    const wi = graph.upsertWorkItem({
      id: "AI-1",
      source: "jira",
      title: "Test item",
    });

    expect(wi.mergedInto).toBeNull();
  });

  it("getWorkItemById returns mergedInto as null by default", () => {
    graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Another item" });

    const fetched = graph.getWorkItemById("AI-2");
    expect(fetched).not.toBeNull();
    expect(fetched!.mergedInto).toBeNull();
  });
});

describe("getRecentChannelContext", () => {
  let db: Database;
  let graph: ContextGraph;

  // Helper: create a timestamp N minutes ago
  function minutesAgo(n: number): string {
    return new Date(Date.now() - n * 60 * 1000).toISOString();
  }

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns recent non-threaded messages from the same channel", () => {
    // Set up two standalone threads in the same channel with different work items
    graph.upsertWorkItem({ id: "AI-10", source: "jira", title: "First work item" });
    graph.upsertWorkItem({ id: "AI-11", source: "jira", title: "Second work item" });

    const agent = graph.upsertAgent({
      id: "agent-1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U001",
    });

    // Thread 1 — standalone (messageCount: 1)
    graph.upsertThread({
      id: "thread-A",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-10",
      messageCount: 1,
    });

    // Thread 2 — standalone (messageCount: 1)
    graph.upsertThread({
      id: "thread-B",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-11",
      messageCount: 1,
    });

    // Insert events for both threads
    graph.insertEvent({
      threadId: "thread-A",
      messageId: "msg-A1",
      workItemId: "AI-10",
      agentId: agent.id,
      status: "in_progress",
      confidence: 0.9,
      rawText: "Working on the first item",
      timestamp: minutesAgo(10),
    });

    graph.insertEvent({
      threadId: "thread-B",
      messageId: "msg-B1",
      workItemId: "AI-11",
      agentId: agent.id,
      status: "in_progress",
      confidence: 0.8,
      rawText: "Working on the second item",
      timestamp: minutesAgo(5),
    });

    // Query excluding thread-B (the "current" thread)
    const result = graph.getRecentChannelContext({
      channelId: "C-general",
      windowMinutes: 30,
      limit: 5,
      excludeThreadId: "thread-B",
    });

    expect(result).toHaveLength(1);
    expect(result[0].workItemId).toBe("AI-10");
    expect(result[0].workItemTitle).toBe("First work item");
    expect(result[0].senderName).toBe("Byte");
    expect(result[0].text).toBe("Working on the first item");
    expect(result[0].timestamp).toBeDefined();
  });

  it("excludes messages older than the window", () => {
    graph.upsertWorkItem({ id: "AI-20", source: "jira", title: "Old work item" });

    graph.upsertThread({
      id: "thread-old",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-20",
      messageCount: 1,
    });

    // Insert event 60 minutes ago
    graph.insertEvent({
      threadId: "thread-old",
      messageId: "msg-old-1",
      workItemId: "AI-20",
      status: "in_progress",
      confidence: 0.9,
      rawText: "This is old news",
      timestamp: minutesAgo(60),
    });

    // Query with 30-minute window
    const result = graph.getRecentChannelContext({
      channelId: "C-general",
      windowMinutes: 30,
    });

    expect(result).toHaveLength(0);
  });

  it("limits results to the limit parameter", () => {
    // Set up 10 standalone threads in the same channel
    for (let i = 1; i <= 10; i++) {
      const wiId = `AI-3${i}`;
      const threadId = `thread-limit-${i}`;
      const msgId = `msg-limit-${i}`;

      graph.upsertWorkItem({ id: wiId, source: "jira", title: `Work item ${i}` });
      graph.upsertThread({
        id: threadId,
        channelId: "C-limits",
        channelName: "limits",
        platform: "slack",
        workItemId: wiId,
        messageCount: 1,
      });
      graph.insertEvent({
        threadId,
        messageId: msgId,
        workItemId: wiId,
        status: "in_progress",
        confidence: 0.9,
        rawText: `Message ${i}`,
        timestamp: minutesAgo(i), // stagger them
      });
    }

    const result = graph.getRecentChannelContext({
      channelId: "C-limits",
      windowMinutes: 30,
      limit: 5,
    });

    expect(result).toHaveLength(5);
  });

  it("excludes messages from multi-message threads", () => {
    graph.upsertWorkItem({ id: "AI-40", source: "jira", title: "Multi-message thread item" });

    // Thread with messageCount: 5 (multi-message, should be excluded)
    graph.upsertThread({
      id: "thread-multi",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-40",
      messageCount: 5,
    });

    graph.insertEvent({
      threadId: "thread-multi",
      messageId: "msg-multi-1",
      workItemId: "AI-40",
      status: "in_progress",
      confidence: 0.9,
      rawText: "This is in a busy thread",
      timestamp: minutesAgo(5),
    });

    const result = graph.getRecentChannelContext({
      channelId: "C-general",
      windowMinutes: 30,
    });

    expect(result).toHaveLength(0);
  });
});
