// tests/core/graph.test.ts — Tests for graph schema and merged_into support

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
      id: "OPS-1",
      source: "jira",
      title: "Test item",
    });

    expect(wi.mergedInto).toBeNull();
  });

  it("getWorkItemById returns mergedInto as null by default", () => {
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Another item" });

    const fetched = graph.getWorkItemById("OPS-2");
    expect(fetched).not.toBeNull();
    expect(fetched!.mergedInto).toBeNull();
  });
});

describe("mergeWorkItems and unmergeWorkItem", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("mergeWorkItems re-links threads and events from source to target", () => {
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "Source item" });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Target item" });

    graph.upsertThread({
      id: "thread-src",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-1",
      messageCount: 1,
    });

    graph.insertEvent({
      threadId: "thread-src",
      messageId: "msg-src-1",
      workItemId: "OPS-1",
      status: "in_progress",
      confidence: 0.9,
      rawText: "Working on source item",
      timestamp: new Date().toISOString(),
    });

    graph.mergeWorkItems("OPS-1", "OPS-2");

    // Thread should now be linked to target
    const thread = graph.getThreadById("thread-src");
    expect(thread).not.toBeNull();
    expect(thread!.workItemId).toBe("OPS-2");

    // Source should have merged_into set
    const source = graph.getWorkItemById("OPS-1");
    expect(source).not.toBeNull();
    expect(source!.mergedInto).toBe("OPS-2");

    // Events should now be linked to target
    const events = graph.getEventsForWorkItem("OPS-2");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.rawText === "Working on source item")).toBe(true);
  });

  it("mergeWorkItems returns merge record for undo", () => {
    graph.upsertWorkItem({ id: "OPS-10", source: "jira", title: "Source to merge" });
    graph.upsertWorkItem({ id: "OPS-11", source: "jira", title: "Merge target" });

    graph.upsertThread({
      id: "thread-merge-1",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-10",
      messageCount: 1,
    });

    const record = graph.mergeWorkItems("OPS-10", "OPS-11");

    expect(record.sourceId).toBe("OPS-10");
    expect(record.targetId).toBe("OPS-11");
    expect(record.sourceTitle).toBe("Source to merge");
    expect(record.movedThreadIds).toEqual(["thread-merge-1"]);
  });

  it("unmergeWorkItem reverses a merge", () => {
    graph.upsertWorkItem({ id: "thread:t-abc", source: "synthetic", title: "Synthetic item" });
    graph.upsertWorkItem({ id: "OPS-20", source: "jira", title: "Real item" });

    graph.upsertThread({
      id: "t-abc",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "thread:t-abc",
      messageCount: 1,
    });

    graph.insertEvent({
      threadId: "t-abc",
      messageId: "msg-abc-1",
      workItemId: "thread:t-abc",
      status: "in_progress",
      confidence: 0.8,
      rawText: "Doing something",
      timestamp: new Date().toISOString(),
    });

    // Merge the synthetic item into the real one
    graph.mergeWorkItems("thread:t-abc", "OPS-20");

    // Verify merged state
    const merged = graph.getWorkItemById("thread:t-abc");
    expect(merged!.mergedInto).toBe("OPS-20");

    // Now unmerge
    graph.unmergeWorkItem("thread:t-abc");

    // merged_into should be cleared
    const unmerged = graph.getWorkItemById("thread:t-abc");
    expect(unmerged!.mergedInto).toBeNull();

    // Thread should be back on source
    const thread = graph.getThreadById("t-abc");
    expect(thread!.workItemId).toBe("thread:t-abc");
  });

  it("mergeWorkItems throws for non-existent source", () => {
    graph.upsertWorkItem({ id: "OPS-30", source: "jira", title: "Real target" });

    expect(() => graph.mergeWorkItems("OPS-nonexistent", "OPS-30")).toThrow(
      "Source work item not found: OPS-nonexistent"
    );
  });

  it("unmergeWorkItem throws for non-merged item", () => {
    graph.upsertWorkItem({ id: "OPS-40", source: "jira", title: "Not merged" });

    expect(() => graph.unmergeWorkItem("OPS-40")).toThrow(
      "Work item OPS-40 is not merged"
    );
  });

  it("mergeWorkItems refuses to merge an item into itself", () => {
    graph.upsertWorkItem({ id: "OPS-41", source: "jira", title: "Alone" });

    expect(() => graph.mergeWorkItems("OPS-41", "OPS-41")).toThrow("into itself");
  });
});

describe("merging moves mentions, subjects, targets and digest checks", () => {
  let db: Database;
  let graph: ContextGraph;
  const at = "2026-10-15T09:00:00.000Z";

  // Every row that can point at a work item, in a stable order
  function snapshot() {
    const all = (sql: string) => db.db.prepare(sql).all();
    return {
      threads: all("SELECT id, work_item_id FROM threads ORDER BY id"),
      events: all("SELECT id, work_item_id FROM events ORDER BY id"),
      links: all("SELECT * FROM thread_work_items ORDER BY thread_id, work_item_id"),
      subjects: all("SELECT * FROM event_subjects ORDER BY event_id, work_item_id"),
      targets: all("SELECT * FROM event_targets ORDER BY event_id, work_item_id"),
      checks: all("SELECT * FROM digest_checks ORDER BY event_id, work_item_id"),
    };
  }
  const rowsFor = (table: string, id: string) =>
    db.db.prepare(`SELECT * FROM ${table} WHERE work_item_id = ?`).all(id) as Array<Record<string, unknown>>;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas", avatarUrl: null, isBot: true });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Source", currentAtcStatus: "in_progress" });
    graph.upsertWorkItem({ id: "ENG-202", source: "jira", title: "Target", currentAtcStatus: "in_progress" });
    // T-SRC is the source's own thread; T-TGT is the target's and mentions the source; T-BOTH mentions both
    graph.upsertThread({ id: "T-SRC", channelId: "C1", platform: "slack", workItemId: "OPS-101" });
    graph.upsertThread({ id: "T-TGT", channelId: "C1", platform: "slack", workItemId: "ENG-202" });
    graph.upsertThread({ id: "T-BOTH", channelId: "C1", platform: "slack" });
    graph.linkThreadWorkItem("T-SRC", "OPS-101", "primary");
    graph.linkThreadWorkItem("T-TGT", "ENG-202", "primary");
    graph.linkThreadWorkItem("T-TGT", "OPS-101", "mentioned");
    graph.linkThreadWorkItem("T-BOTH", "OPS-101", "primary");
    graph.linkThreadWorkItem("T-BOTH", "ENG-202", "mentioned");

    const own = graph.insertEvent({ threadId: "T-SRC", messageId: "m1", workItemId: "OPS-101", agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, timestamp: at });
    const digest = graph.insertEvent({ threadId: "T-TGT", messageId: "m2", workItemId: "ENG-202", agentId: "U-atlas", status: "in_progress", confidence: 0.9, timestamp: at, digest: true });
    graph.addEventTarget(own.id, "OPS-101");
    graph.addEventSubject(digest.id, "OPS-101", { status: "blocked_on_human", actionRequiredFrom: ["U0OPERATOR1"], confidence: 0.8 });
    graph.addEventSubject(digest.id, "ENG-202", { status: "in_progress", actionRequiredFrom: null, confidence: 0.7 });
    graph.recordDigestCheck({ eventId: digest.id, workItemId: "OPS-101", digestStatus: "completed", digestTargeted: false, itemStatus: "in_progress", at });
  });

  afterEach(() => {
    db.close();
  });

  it("leaves nothing pointing at the source, keeping the target's own row where both had one", () => {
    graph.mergeWorkItems("OPS-101", "ENG-202");

    for (const table of ["thread_work_items", "event_subjects", "event_targets", "digest_checks"]) {
      expect(rowsFor(table, "OPS-101")).toEqual([]);
    }
    const links = db.db.prepare("SELECT thread_id, relation FROM thread_work_items WHERE work_item_id = 'ENG-202' ORDER BY thread_id").all();
    // T-BOTH's own item was the source: the target becomes its own
    expect(links).toEqual([
      { thread_id: "T-BOTH", relation: "primary" },
      { thread_id: "T-SRC", relation: "primary" },
      { thread_id: "T-TGT", relation: "primary" },
    ]);
    // The message's own line for the target wins over its line for the source
    expect(rowsFor("event_subjects", "ENG-202")).toEqual([expect.objectContaining({ status: "in_progress", confidence: 0.7 })]);
    expect(rowsFor("event_targets", "ENG-202")).toHaveLength(1);
    expect(rowsFor("digest_checks", "ENG-202")).toEqual([expect.objectContaining({ digest_status: "completed" })]);
  });

  it("unmergeWorkItem puts back exactly what the merge moved", () => {
    const before = snapshot();

    graph.mergeWorkItems("OPS-101", "ENG-202");
    graph.unmergeWorkItem("OPS-101");

    expect(snapshot()).toEqual(before);
    expect(graph.getWorkItemById("OPS-101")!.mergedInto).toBeNull();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM work_item_merges").get()).toEqual({ n: 0 });
  });

  it("unmergeWorkItem gives back a message posted in a moved thread after the merge", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      graph.mergeWorkItems("OPS-101", "ENG-202");
      // The source's thread now belongs to the target, so a new message in it takes the target
      vi.setSystemTime(new Date("2026-10-15T11:00:00.000Z"));
      const later = graph.insertEvent({ threadId: "T-SRC", messageId: "m3", workItemId: "ENG-202", agentId: "U-atlas", status: "in_progress", confidence: 0.9, timestamp: "2026-10-15T11:00:00.000Z" });
      // A message in the target's own thread stays the target's
      const other = graph.insertEvent({ threadId: "T-TGT", messageId: "m4", workItemId: "ENG-202", agentId: "U-atlas", status: "in_progress", confidence: 0.9, timestamp: "2026-10-15T11:00:00.000Z" });

      graph.unmergeWorkItem("OPS-101");

      const itemOf = (id: string) => (db.db.prepare("SELECT work_item_id FROM events WHERE id = ?").get(id) as { work_item_id: string }).work_item_id;
      expect(itemOf(later.id)).toBe("OPS-101");
      expect(itemOf(other.id)).toBe("ENG-202");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmergeWorkItem still gives a conversation item merged before merges were recorded its thread back", () => {
    graph.upsertWorkItem({ id: "thread:T-CONV", source: "inferred", title: "Conversation" });
    graph.upsertThread({ id: "T-CONV", channelId: "C1", platform: "slack", workItemId: "thread:T-CONV" });
    const event = graph.insertEvent({ threadId: "T-CONV", messageId: "m5", workItemId: "thread:T-CONV", agentId: "U-atlas", status: "in_progress", confidence: 0.9, timestamp: at });
    graph.mergeWorkItems("thread:T-CONV", "ENG-202");
    // As an earlier build left it: merged, with no record of what moved
    db.db.prepare("DELETE FROM work_item_merges").run();

    graph.unmergeWorkItem("thread:T-CONV");

    expect(graph.getThreadById("T-CONV")!.workItemId).toBe("thread:T-CONV");
    expect((db.db.prepare("SELECT work_item_id FROM events WHERE id = ?").get(event.id) as { work_item_id: string }).work_item_id)
      .toBe("thread:T-CONV");
    expect(graph.getWorkItemById("thread:T-CONV")!.mergedInto).toBeNull();
  });

  it("refuses to merge an item twice, into a merged item, or back into the item merged into it", () => {
    graph.upsertWorkItem({ id: "OPS-103", source: "jira", title: "Third" });
    graph.mergeWorkItems("OPS-101", "ENG-202");
    const record = db.db.prepare("SELECT * FROM work_item_merges").all();

    // Again: would replace the first merge's undo record
    expect(() => graph.mergeWorkItems("OPS-101", "OPS-103")).toThrow("OPS-101 is already merged into ENG-202");
    // Into a merged item: a chain
    expect(() => graph.mergeWorkItems("OPS-103", "OPS-101")).toThrow("merge into that instead");
    // Back into its source: a cycle
    expect(() => graph.mergeWorkItems("ENG-202", "OPS-101")).toThrow("merge into that instead");

    expect(db.db.prepare("SELECT * FROM work_item_merges").all()).toEqual(record);
    expect(graph.getWorkItemById("ENG-202")!.mergedInto).toBeNull();
  });

  it("refuses to unmerge an item whose target has been merged since, until that's unmerged", () => {
    graph.upsertWorkItem({ id: "OPS-103", source: "jira", title: "Third" });
    const before = snapshot();
    graph.mergeWorkItems("OPS-101", "ENG-202");
    graph.mergeWorkItems("ENG-202", "OPS-103");

    expect(() => graph.unmergeWorkItem("OPS-101")).toThrow("unmerge it first");
    expect(graph.getWorkItemById("OPS-101")!.mergedInto).toBe("ENG-202");

    graph.unmergeWorkItem("ENG-202");
    graph.unmergeWorkItem("OPS-101");
    expect(snapshot()).toEqual(before);
  });
});

describe("merged items excluded from queries", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("getActionableItems excludes merged work items", () => {
    // Create two work items, both actionable (needs_decision)
    graph.upsertWorkItem({ id: "WI-merged", source: "test", title: "Merged", currentAtcStatus: "needs_decision" });
    graph.upsertWorkItem({ id: "WI-visible", source: "test", title: "Visible", currentAtcStatus: "needs_decision" });
    graph.upsertAgent({ id: "U1", name: "Agent", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: true });

    for (const wiId of ["WI-merged", "WI-visible"]) {
      graph.upsertThread({
        id: `t-${wiId}`, channelId: "C1", channelName: "#test",
        platform: "slack", workItemId: wiId,
        lastActivity: new Date().toISOString(), messageCount: 1,
      });
      graph.insertEvent({
        threadId: `t-${wiId}`, messageId: `msg-${wiId}`, workItemId: wiId,
        agentId: "U1", status: "needs_decision", confidence: 0.9,
        reason: "test", rawText: "Help", timestamp: new Date().toISOString(),
        targetedAtOperator: true,
      });
    }

    // Merge one
    graph.mergeWorkItems("WI-merged", "WI-visible");

    const items = graph.getActionableItems();
    const ids = items.map((i: any) => i.workItem.id);
    expect(ids).not.toContain("WI-merged");
    expect(ids).toContain("WI-visible");
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

  it("measures the window from the message's own time during a catch-up", () => {
    graph.upsertWorkItem({ id: "OPS-20", source: "jira", title: "Earlier item" });
    graph.upsertWorkItem({ id: "OPS-21", source: "jira", title: "Later item" });
    const agent = graph.upsertAgent({ id: "agent-1", name: "Relay", platform: "slack", platformUserId: "U001" });
    for (const [id, wi] of [["thread-old", "OPS-20"], ["thread-after", "OPS-21"]]) {
      graph.upsertThread({ id, channelId: "C-general", channelName: "general", platform: "slack", workItemId: wi, messageCount: 1 });
    }
    // Two days ago: the message being classified, 10 minutes after the earlier one
    graph.insertEvent({ threadId: "thread-old", messageId: "m-old", workItemId: "OPS-20", agentId: agent.id,
      status: "in_progress", confidence: 0.9, rawText: "Earlier message", timestamp: minutesAgo(2 * 24 * 60 + 10) });
    // Posted after the message being classified: not context for it
    graph.insertEvent({ threadId: "thread-after", messageId: "m-after", workItemId: "OPS-21", agentId: agent.id,
      status: "in_progress", confidence: 0.9, rawText: "Later message", timestamp: minutesAgo(2 * 24 * 60 - 5) });

    const result = graph.getRecentChannelContext({
      channelId: "C-general", windowMinutes: 30, excludeThreadId: "thread-current", before: minutesAgo(2 * 24 * 60),
    });

    expect(result.map((r) => r.workItemId)).toEqual(["OPS-20"]);
  });

  it("returns recent non-threaded messages from the same channel", () => {
    // Set up two standalone threads in the same channel with different work items
    graph.upsertWorkItem({ id: "OPS-10", source: "jira", title: "First work item" });
    graph.upsertWorkItem({ id: "OPS-11", source: "jira", title: "Second work item" });

    const agent = graph.upsertAgent({
      id: "agent-1",
      name: "Relay",
      platform: "slack",
      platformUserId: "U001",
    });

    // Thread 1 — standalone (messageCount: 1)
    graph.upsertThread({
      id: "thread-A",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-10",
      messageCount: 1,
    });

    // Thread 2 — standalone (messageCount: 1)
    graph.upsertThread({
      id: "thread-B",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-11",
      messageCount: 1,
    });

    // Insert events for both threads
    graph.insertEvent({
      threadId: "thread-A",
      messageId: "msg-A1",
      workItemId: "OPS-10",
      agentId: agent.id,
      status: "in_progress",
      confidence: 0.9,
      rawText: "Working on the first item",
      timestamp: minutesAgo(10),
    });

    graph.insertEvent({
      threadId: "thread-B",
      messageId: "msg-B1",
      workItemId: "OPS-11",
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
    expect(result[0].workItemId).toBe("OPS-10");
    expect(result[0].workItemTitle).toBe("First work item");
    expect(result[0].senderName).toBe("Relay");
    expect(result[0].text).toBe("Working on the first item");
    expect(result[0].timestamp).toBeDefined();
  });

  it("excludes messages older than the window", () => {
    graph.upsertWorkItem({ id: "OPS-20", source: "jira", title: "Old work item" });

    graph.upsertThread({
      id: "thread-old",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-20",
      messageCount: 1,
    });

    // Insert event 60 minutes ago
    graph.insertEvent({
      threadId: "thread-old",
      messageId: "msg-old-1",
      workItemId: "OPS-20",
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
      const wiId = `OPS-3${i}`;
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
    graph.upsertWorkItem({ id: "OPS-40", source: "jira", title: "Multi-message thread item" });

    // Thread with messageCount: 5 (multi-message, should be excluded)
    graph.upsertThread({
      id: "thread-multi",
      channelId: "C-general",
      channelName: "general",
      platform: "slack",
      workItemId: "OPS-40",
      messageCount: 5,
    });

    graph.insertEvent({
      threadId: "thread-multi",
      messageId: "msg-multi-1",
      workItemId: "OPS-40",
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
