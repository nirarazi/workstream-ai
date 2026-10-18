// tests/core/pipeline-digests.test.ts — messages naming several work items inform them but don't decide them

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline, DIGEST_MIN_ITEMS } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker, namesDigest } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification } from "../../core/types.js";

const CONFIG = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 }, taskAdapter: { ticketPrefixes: [] } } as any;
const extractor = () => new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] });

function breakdown(workItemId: string, status: Classification["status"], targetedAtOperator = false) {
  return { workItemId, status, entryType: "progress" as const, confidence: 0.9, reason: "", title: workItemId, targetedAtOperator, actionRequiredFrom: null, nextAction: null };
}

let db: Database;
afterEach(() => db?.close());

function setup(text: string, answer: Classification, threadId = "T-DIGEST", senderType: "agent" | "human" = "agent", config = CONFIG) {
  db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const linker = new WorkItemLinker(graph, [extractor()]);
  const message = {
    id: "m1", threadId, channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
    text, timestamp: "2026-10-15T09:00:00.000Z", platform: "slack", senderType,
  };
  const adapter = {
    name: "fake",
    readThreads: vi.fn(async () => [{ id: threadId, channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
    getThreadMessages: vi.fn(async () => []),
  } as any;
  const classify = vi.fn(async () => answer);
  const pipeline = new Pipeline(adapter, { classify } as any, graph, linker, undefined, config);
  return { graph, pipeline, adapter, classify, message };
}

// The whole message reads as needing the operator, but no line puts a particular item in front of them
const DIGEST_TEXT = "Daily digest: OPS-1 still blocked on Dana, OPS-2 blocked on review, OPS-3 shipped";
const DIGEST_ANSWER: Classification = {
  status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "round-up, a few things are stuck",
  workItemIds: ["OPS-1", "OPS-2", "OPS-3"], title: "Daily digest", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: null,
  breakdown: [breakdown("OPS-1", "blocked_on_human"), breakdown("OPS-2", "blocked_on_human"), breakdown("OPS-3", "completed")],
};

describe("Pipeline: digests", () => {
  it("names a digest from DIGEST_MIN_ITEMS work items", () => {
    expect(DIGEST_MIN_ITEMS).toBe(3);
  });

  it("checks what a digest says against each item instead of changing it", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", currentConfidence: 0.5 });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human", currentConfidence: 0.5 });
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", title: "Three", currentAtcStatus: "completed", currentConfidence: 0.5 });

    await pipeline.processOnce();

    // Statuses are untouched, even where the digest disagrees
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("in_progress");
    expect(graph.getWorkItemById("OPS-2")!.currentAtcStatus).toBe("blocked_on_human");
    const checks = db.db.prepare("SELECT work_item_id, digest_status, item_status, agrees FROM digest_checks ORDER BY work_item_id").all();
    expect(checks).toEqual([
      { work_item_id: "OPS-1", digest_status: "blocked_on_human", item_status: "in_progress", agrees: 0 },
      { work_item_id: "OPS-2", digest_status: "blocked_on_human", item_status: "blocked_on_human", agrees: 1 },
      { work_item_id: "OPS-3", digest_status: "completed", item_status: "completed", agrees: 1 },
    ]);
    expect(graph.getOpenDigestDisagreements().map((d) => d.workItemId)).toEqual(["OPS-1"]);

    // None of them becomes the thread's own; the digest still shows in each one's timeline
    expect(graph.getThreadById("T-DIGEST")!.workItemId).toBeNull();
    const links = db.db.prepare("SELECT work_item_id, relation FROM thread_work_items WHERE thread_id = 'T-DIGEST' ORDER BY work_item_id").all();
    expect(links).toEqual([
      { work_item_id: "OPS-1", relation: "mentioned" },
      { work_item_id: "OPS-2", relation: "mentioned" },
      { work_item_id: "OPS-3", relation: "mentioned" },
    ]);
    expect(graph.getEventByMessageId("m1", "T-DIGEST")!.digest).toBe(true);
  });

  it("puts an item in Needs me when its own line says it needs the operator, even in a digest", async () => {
    const answer: Classification = {
      status: "blocked_on_human", entryType: "block", confidence: 0.95, reason: "approval needed", workItemIds: ["OPS-101", "OPS-102", "OPS-103"],
      title: "Deploy approval", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: "Approve",
      breakdown: [breakdown("OPS-101", "blocked_on_human", true), breakdown("OPS-102", "in_progress"), breakdown("OPS-103", "in_progress")],
    };
    const { graph, pipeline } = setup("I need your approval to deploy OPS-101 to prod; it unblocks OPS-102 and OPS-103", answer);
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Deploy", currentAtcStatus: "in_progress", currentConfidence: 0.5 });
    graph.upsertWorkItem({ id: "OPS-102", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human", currentConfidence: 0.5 });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBe("blocked_on_human");
    // Only the item its line escalates: not OPS-102, though the whole message reads as blocked
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-101"]);
  });

  it("doesn't count a message in a thread that merely mentions an item, for that item", () => {
    db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
    graph.upsertWorkItem({ id: "OPS-9", source: "jira", title: "Nine", currentAtcStatus: "blocked_on_human" });
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "T-OTHER", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OTHER", "OPS-9", "mentioned");
    graph.insertEvent({ threadId: "T-OTHER", messageId: "x", workItemId: "OPS-1", agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, entryType: "block", targetedAtOperator: true, timestamp: new Date().toISOString() });

    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-9");

    // In the item's own thread it does count
    graph.upsertThread({ id: "T-NINE", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-9" });
    graph.linkThreadWorkItem("T-NINE", "OPS-9", "primary");
    graph.insertEvent({ threadId: "T-NINE", messageId: "y", workItemId: null, agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, entryType: "block", targetedAtOperator: true, timestamp: new Date().toISOString() });
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-9");
  });

  it("doesn't put a digest-seeded item in Needs me through a later reply in the digest's thread", async () => {
    const answer: Classification = { ...DIGEST_ANSWER, workItemIds: ["OPS-7", "OPS-8", "OPS-9"], breakdown: [breakdown("OPS-9", "blocked_on_human")] };
    const { graph, pipeline, adapter, classify, message } = setup("Round-up: OPS-7, OPS-8 moving, OPS-9 blocked on Dana", answer);
    // A digest doesn't create the items it names (see below): these are known already, with no status of their own
    for (const id of ["OPS-7", "OPS-8", "OPS-9"]) graph.upsertWorkItem({ id, source: "jira", title: id });
    await pipeline.processOnce();
    expect(graph.getWorkItemById("OPS-9")!.currentAtcStatus).toBe("blocked_on_human");

    const reply = { ...message, id: "m2", userId: "U-relay", userName: "Relay", text: "thoughts on the above?", timestamp: "2026-10-15T10:00:00.000Z" };
    adapter.readThreads.mockResolvedValue([{ id: "T-DIGEST", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: reply.timestamp, messageCount: 2, messages: [message, reply] }]);
    classify.mockResolvedValue({ status: "needs_decision", entryType: "block", confidence: 0.9, reason: "asks the operator", workItemIds: [], title: "Thoughts", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: null });
    await pipeline.processOnce();

    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-9");
  });

  it("doesn't put the items it names in Needs me", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human" });

    await pipeline.processOnce();

    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
  });

  it("leaves a message naming fewer items as it was", async () => {
    const answer: Classification = {
      ...DIGEST_ANSWER, workItemIds: ["OPS-1", "OPS-2"], breakdown: [breakdown("OPS-1", "blocked_on_human", true), breakdown("OPS-2", "completed")],
    };
    const { graph, pipeline } = setup("OPS-1 is blocked on Alex; OPS-2 shipped", answer, "T-PAIR");
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", currentConfidence: 0.5 });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getThreadById("T-PAIR")!.workItemId).toBe("OPS-1");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-1");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks").get()).toEqual({ n: 0 });
  });

  it("marks digests stored before they were told apart, once and undoably, and stops them putting items in Needs me", () => {
    db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas", isBot: true });
    graph.upsertAgent({ id: "U-dana", name: "Dana", platform: "slack", platformUserId: "U-dana", isBot: false });
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "blocked_on_human" });
    // The old rule made the digest's first ticket the thread's own
    graph.upsertThread({ id: "T-OLD", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OLD", "OPS-1", "primary");
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OWN", "OPS-1", "primary");
    const base = { workItemId: "OPS-1", agentId: "U-atlas", status: "blocked_on_human" as const, confidence: 0.9, entryType: "block" as const, targetedAtOperator: true };
    graph.insertEvent({ ...base, threadId: "T-OLD", messageId: "d1", rawText: DIGEST_TEXT, timestamp: "2026-10-15T09:00:00.000Z" });
    graph.insertEvent({ ...base, threadId: "T-OWN", messageId: "own0", rawText: "Starting OPS-1", timestamp: "2026-10-13T09:00:00.000Z" });
    graph.insertEvent({ ...base, threadId: "T-OWN", messageId: "own1", rawText: "Blocked on OPS-1: same for OPS-2, OPS-3 and OPS-4", timestamp: "2026-10-14T09:00:00.000Z" });
    graph.insertEvent({ ...base, threadId: "T-OWN", messageId: "human", agentId: "U-dana", rawText: "OPS-2, OPS-3, OPS-4 approved", timestamp: "2026-10-14T10:00:00.000Z" });
    const ids = (text: string) => extractor().extractWorkItemIds(text);

    expect(graph.backfillDigests(namesDigest, ids).length).toBe(1);
    expect(graph.getEventByMessageId("d1", "T-OLD")!.digest).toBe(true);
    // A reply in its item's own thread, and a human's message, stay as they were
    expect(graph.getEventByMessageId("own1", "T-OWN")!.digest).toBe(false);
    expect(graph.getEventByMessageId("human", "T-OWN")!.digest).toBe(false);
    expect(graph.getActionableItems()[0].latestEvent!.messageId).not.toBe("d1");

    db.db.prepare("UPDATE events SET digest = 0 WHERE digest = 2").run(); // the documented undo
    expect(graph.getEventByMessageId("d1", "T-OLD")!.digest).toBe(false);
  });

  it("keeps the backfill owed, in the database, until it has run", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ws-digest-")), "graph.db");
    const first = new Database(file);
    expect(first.digestBackfillPending).toBe(true);
    first.close();
    // Opened again (say by the MCP server) before the engine ran it: still owed
    const second = new Database(file);
    expect(second.digestBackfillPending).toBe(true);
    new ContextGraph(second).backfillDigests(namesDigest, () => []);
    expect(second.digestBackfillPending).toBe(false);
    second.close();
    const third = new Database(file);
    expect(third.digestBackfillPending).toBe(false);
    third.close();
  });

  it("handles a reply in an item's own thread as usual, even when it names two other tickets", async () => {
    const answer: Classification = {
      status: "blocked_on_human", entryType: "block", confidence: 0.95, reason: "needs approval for prod creds",
      workItemIds: ["OPS-1", "OPS-2", "OPS-3"], title: "Prod creds", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: "Approve",
    };
    const { graph, pipeline } = setup("Blocked on OPS-1: need your approval for prod creds. Same issue will hit OPS-2 and OPS-3.", answer, "T-OWN");
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", currentConfidence: 0.5 });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1", lastActivity: "2026-10-15T08:00:00.000Z" });
    graph.linkThreadWorkItem("T-OWN", "OPS-1", "primary");

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toContain("OPS-1");
    expect(graph.getThreadById("T-OWN")!.workItemId).toBe("OPS-1");
  });

  it("doesn't count tickets the model adds, only those the message names", async () => {
    const answer: Classification = { ...DIGEST_ANSWER, workItemIds: ["OPS-1", "OPS-2", "OPS-3"], breakdown: undefined };
    const { graph, pipeline } = setup("OPS-1 is blocked on Alex; OPS-2 is related", answer, "T-TWO");
    graph.upsertWorkItem({ id: "OPS-3", source: "jira", title: "Three", currentAtcStatus: "in_progress" });

    await pipeline.processOnce();

    expect(graph.getEventByMessageId("m1", "T-TWO")!.digest).toBe(false);
    expect(graph.getThreadById("T-TWO")!.workItemId).toBe("OPS-1");
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
  });

  it("never treats a human's message as a digest", async () => {
    const answer: Classification = { ...DIGEST_ANSWER, status: "in_progress", targetedAtOperator: false, breakdown: undefined };
    const { graph, pipeline } = setup("OPS-1, OPS-2 and OPS-3 are approved, go ahead", answer, "T-HUMAN", "human");

    await pipeline.processOnce();

    expect(graph.getEventByMessageId("m1", "T-HUMAN")!.digest).toBe(false);
    expect(graph.getThreadById("T-HUMAN")!.workItemId).toBe("OPS-1");
  });

  it("keeps a repeated digest a digest", async () => {
    const { graph, pipeline, adapter, message } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human" });
    await pipeline.processOnce();
    const again = { ...message, id: "m2", timestamp: "2026-10-15T10:00:00.000Z" };
    adapter.readThreads.mockResolvedValue([{ id: "T-DIGEST", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: again.timestamp, messageCount: 2, messages: [message, again] }]);

    await pipeline.processOnce();

    expect(graph.getEventByMessageId("m2", "T-DIGEST")!.digest).toBe(true);
    expect(graph.getActionableItems().map((i) => i.workItem.id)).not.toContain("OPS-2");
  });

  it("gives a known item with no status yet a first status from its own line, still outside Needs me", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    // Known items with no status (a digest doesn't create the ones it only names: see below)
    for (const id of ["OPS-1", "OPS-2", "OPS-3"]) graph.upsertWorkItem({ id, source: "jira", title: id });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getWorkItemById("OPS-1")!.currentConfidence).toBe(0);
    // Done isn't seeded: it would hold the item there
    expect(graph.getWorkItemById("OPS-3")!.currentAtcStatus).toBeNull();
    expect(graph.getAllActiveItems().map((i) => i.workItem.id)).toContain("OPS-1");
    expect(graph.getActionableItems()).toEqual([]);
    expect(db.db.prepare("SELECT agrees FROM digest_checks WHERE work_item_id = 'OPS-1'").get()).toEqual({ agrees: null });
  });

  it("doesn't give items the whole message's status, and a direct message about one still wins", async () => {
    const answer: Classification = {
      status: "in_progress", entryType: "progress", confidence: 0.97, reason: "all moving", workItemIds: ["OPS-7", "OPS-8", "OPS-9"],
      title: "Daily", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    };
    const { graph, pipeline, adapter, classify, message } = setup("Daily: OPS-7, OPS-8, OPS-9 all moving", answer);
    for (const id of ["OPS-7", "OPS-8", "OPS-9"]) graph.upsertWorkItem({ id, source: "jira", title: id });
    await pipeline.processOnce();
    expect(graph.getWorkItemById("OPS-7")!.currentAtcStatus).toBeNull();
    // Every named item is still checked, with the whole message's status
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks").get()).toEqual({ n: 3 });

    const blocker = { ...message, id: "m2", threadId: "T-RELAY", userId: "U-relay", userName: "Relay", text: "OPS-7 is blocked: I need your approval to rotate the prod key", timestamp: "2026-10-15T10:00:00.000Z" };
    adapter.readThreads.mockResolvedValue([{ id: "T-RELAY", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: blocker.timestamp, messageCount: 1, messages: [blocker] }]);
    classify.mockResolvedValue({
      status: "blocked_on_human", entryType: "block", confidence: 0.9, reason: "needs approval", workItemIds: ["OPS-7"],
      title: "Rotate key", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: "Approve",
    });
    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-7")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-7"]);
  });

  it("counts a digest posted in an item's own thread for that item only", async () => {
    const answer: Classification = {
      status: "blocked_on_human", entryType: "block", confidence: 0.95, reason: "round-up", workItemIds: ["OPS-2", "OPS-3", "OPS-4"],
      title: "Round-up", targetedAtOperator: true, actionRequiredFrom: ["U0OPERATOR1"], nextAction: null,
      breakdown: [breakdown("OPS-2", "blocked_on_human", true), breakdown("OPS-3", "in_progress"), breakdown("OPS-4", "in_progress")],
    };
    const { graph, pipeline } = setup("Round-up: OPS-2 blocked, OPS-3 and OPS-4 moving", answer, "T-OWN");
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "blocked_on_human", currentConfidence: 0.5 });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1", lastActivity: "2026-10-15T08:00:00.000Z" });
    graph.linkThreadWorkItem("T-OWN", "OPS-1", "primary");
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", title: "Two", currentAtcStatus: "blocked_on_human" });
    graph.dismissWorkItem("OPS-2");

    await pipeline.processOnce();

    const needsMe = graph.getActionableItems().map((i) => i.workItem.id);
    expect(needsMe).toContain("OPS-1");
    expect(needsMe).not.toContain("OPS-2");
    expect(graph.getEventByMessageId("m1", "T-OWN")!.digest).toBe(true);
  });

  it("doesn't check a digest held back for a retry against a status set after it", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "in_progress", statusAt: "2026-10-15T12:00:00.000Z" });

    await pipeline.processOnce();

    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks WHERE work_item_id = 'OPS-1'").get()).toEqual({ n: 0 });
  });

  it("doesn't count a digest as handing an item to someone else, or as activity that keeps it from expiring", () => {
    db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
    graph.upsertWorkItem({ id: "OPS-1", source: "jira", title: "One", currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OWN", "OPS-1", "primary");
    graph.upsertThread({ id: "T-DIGEST", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null });
    graph.linkThreadWorkItem("T-DIGEST", "OPS-1", "mentioned");
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    const recent = new Date(Date.now() - 86400000).toISOString();
    graph.insertEvent({ threadId: "T-OWN", messageId: "own", workItemId: "OPS-1", agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, entryType: "block", targetedAtOperator: true, timestamp: old });
    graph.insertEvent({ threadId: "T-DIGEST", messageId: "dig", workItemId: null, agentId: "U-atlas", status: "blocked_on_human", confidence: 0.95, entryType: "block", targetedAtOperator: false, actionRequiredFrom: ["U-dana"], timestamp: recent, digest: true });

    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-1"]);
    expect(graph.expireInactiveItems(14)).toBe(1);
  });

  it("counts a relinked thread's messages for its new item, not its old one", () => {
    db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
    for (const id of ["OPS-1", "OPS-5"]) graph.upsertWorkItem({ id, source: "jira", title: id, currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T-1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-1", "OPS-1", "primary");
    graph.insertEvent({ threadId: "T-1", messageId: "x", workItemId: null, agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9, entryType: "block", targetedAtOperator: true, timestamp: new Date().toISOString() });
    const needsMe = () => graph.getActionableItems().map((i) => i.workItem.id);
    expect(needsMe()).toEqual(["OPS-1"]);

    graph.linkThread("T-1", "OPS-5");
    expect(needsMe()).toEqual(["OPS-5"]);

    graph.unlinkThread("T-1");
    expect(needsMe()).toEqual([]);
  });

  it("has the digest judge settle disagreements after a poll", async () => {
    const { pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    const judge = { judgeSome: vi.fn(async () => ({ settled: 0, asked: 0 })) };
    pipeline.setDigestJudge(judge as any);

    await pipeline.processOnce();

    expect(judge.judgeSome).toHaveBeenCalledTimes(1);
  });

  it("runs the judge one run at a time", async () => {
    const { pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);
    const judge = { judgeSome: vi.fn(() => new Promise<{ settled: number; asked: number }>(() => {})) };
    pipeline.setDigestJudge(judge as any);

    await pipeline.processOnce();
    await pipeline.processOnce();

    expect(judge.judgeSome).toHaveBeenCalledTimes(1);
  });
});

describe("Pipeline: IDs only mentioned in passing", () => {
  it("makes no work items, nor a conversation item, for a digest naming tickets the model doesn't take up", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, { ...DIGEST_ANSWER, workItemIds: [], breakdown: [] });

    await pipeline.processOnce();

    for (const id of ["OPS-1", "OPS-2", "OPS-3", "thread:T-DIGEST"]) expect(graph.getWorkItemById(id)).toBeNull();
    const event = graph.getEventByMessageId("m1", "T-DIGEST")!;
    expect(event.digest).toBe(true);
    expect(event.workItemId).toBeNull();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM thread_work_items").get()).toEqual({ n: 0 });
  });

  it("makes no work items for the tickets a digest names, though the model lists them all", async () => {
    const { graph, pipeline } = setup(DIGEST_TEXT, DIGEST_ANSWER);

    await pipeline.processOnce();

    for (const id of ["OPS-1", "OPS-2", "OPS-3", "thread:T-DIGEST"]) expect(graph.getWorkItemById(id)).toBeNull();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM digest_checks").get()).toEqual({ n: 0 });
  });

  it("still creates an item a digest's own line puts in front of the operator, so the ask isn't lost", async () => {
    const answer: Classification = {
      ...DIGEST_ANSWER,
      breakdown: [breakdown("OPS-1", "blocked_on_human"), breakdown("OPS-2", "needs_decision", true), breakdown("OPS-3", "completed")],
    };
    const { graph, pipeline } = setup(DIGEST_TEXT, answer);

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")).not.toBeNull();
    expect(graph.getWorkItemById("OPS-1")).toBeNull();
    expect(graph.getWorkItemById("OPS-3")).toBeNull();
    expect(db.db.prepare("SELECT work_item_id FROM event_targets").all()).toEqual([{ work_item_id: "OPS-2" }]);
  });

  it("creates a new thread's own ticket, but not one it only mentions, though the model lists both", async () => {
    const { graph, pipeline } = setup("OPS-101 is ready for review, same approach as ENG-202", {
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "ready for review", workItemIds: ["OPS-101", "ENG-202"],
      title: "Review", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }, "T-OWN");

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-101")).not.toBeNull();
    expect(graph.getWorkItemById("ENG-202")).toBeNull();
    expect(graph.getThreadById("T-OWN")!.workItemId).toBe("OPS-101");
    expect(graph.getEventByMessageId("m1", "T-OWN")!.workItemId).toBe("OPS-101");
  });

  it("doesn't create a ticket a reply in another ticket's thread mentions, though the model lists it", async () => {
    const { graph, pipeline } = setup("Unblocked by the fix in ENG-202", {
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "unblocked", workItemIds: ["OPS-101", "ENG-202"],
      title: "Unblocked", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }, "T-OWN");
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Rollout" });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-101" });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("ENG-202")).toBeNull();
    expect(graph.getEventByMessageId("m1", "T-OWN")!.workItemId).toBe("OPS-101");
  });

  it("knows the model's ID in another case for one the text mentions", async () => {
    const { graph, pipeline } = setup("Unblocked by the fix in ENG-202", {
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "unblocked", workItemIds: ["OPS-101", "eng-202"],
      title: "Unblocked", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }, "T-OWN");
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Rollout" });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-101" });

    await pipeline.processOnce();

    expect(graph.getWorkItemById("eng-202")).toBeNull();
    expect(graph.getWorkItemById("ENG-202")).toBeNull();
  });

  it("knows a mention written in lower case, with a space or with another dash as the ID the model gives back", async () => {
    const config = { ...CONFIG, taskAdapter: { ticketPrefixes: ["OPS-"] } };
    const { graph, pipeline } = setup("Same root cause as ops-77, OPS 78 and OPS‑79", {
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "same cause", workItemIds: ["OPS-101", "OPS-77", "OPS-78", "OPS-79"],
      title: "Root cause", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }, "T-OWN", "agent", config);
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Rollout" });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-101" });

    await pipeline.processOnce();

    for (const id of ["OPS-77", "OPS-78", "OPS-79"]) expect(graph.getWorkItemById(id)).toBeNull();
    expect(graph.getEventByMessageId("m1", "T-OWN")!.workItemId).toBe("OPS-101");
  });

  it("creates an item a digest's line puts in front of the operator though the model leaves its ID out", async () => {
    const answer: Classification = {
      ...DIGEST_ANSWER, workItemIds: [],
      breakdown: [breakdown("OPS-1", "blocked_on_human"), breakdown("OPS-2", "needs_decision", true), breakdown("OPS-3", "completed")],
    };
    const { graph, pipeline } = setup(DIGEST_TEXT, answer);

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-2")).not.toBeNull();
    expect(graph.getWorkItemById("OPS-1")).toBeNull();
    expect(db.db.prepare("SELECT work_item_id FROM event_targets").all()).toEqual([{ work_item_id: "OPS-2" }]);
  });

  it("creates at most three items from one message's lines for the operator, and logs the IDs of the rest", async () => {
    const ids = ["OPS-1", "OPS-2", "OPS-3", "OPS-4", "OPS-5"];
    const answer: Classification = {
      ...DIGEST_ANSWER, workItemIds: ids, breakdown: ids.map((id) => breakdown(id, "needs_decision", true)),
    };
    const { graph, pipeline } = setup("Need your call on OPS-1, OPS-2, OPS-3, OPS-4 and OPS-5", answer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await pipeline.processOnce();

      expect(ids.filter((id) => graph.getWorkItemById(id))).toEqual(["OPS-1", "OPS-2", "OPS-3"]);
      const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain("OPS-4, OPS-5");
      expect(logged).not.toContain("Need your call");
    } finally {
      warn.mockRestore();
    }
  });

  it("still takes up a model-suggested ID that isn't in the text", async () => {
    const { graph, pipeline } = setup("The rollout fix is ready for review", {
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "ready", workItemIds: ["OPS-102"],
      title: "Rollout fix", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }, "T-OWN");

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-102")).not.toBeNull();
  });
});
