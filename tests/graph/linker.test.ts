// tests/graph/linker.test.ts — Work item linker tests

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

const defaultConfig = {
  ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
  prPatterns: [],
  ticketPrefixes: [],
};

describe("WorkItemLinker", () => {
  let db: Database;
  let graph: ContextGraph;
  let linker: WorkItemLinker;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    const extractor = new DefaultExtractor(defaultConfig);
    linker = new WorkItemLinker(graph, [extractor]);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the work item for a new thread's own ticket", () => {
    // Create a thread first
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Working on OPS-382", "t1");

    expect(ids).toEqual(["OPS-382"]);
    const wi1 = graph.getWorkItemById("OPS-382");
    expect(wi1).not.toBeNull();
    expect(wi1!.source).toBe("extracted");
  });

  it("links an ID mentioned alongside the thread's own ticket only when it's a work item already", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Working on OPS-382, same fix as ENG-100", "t1");

    expect(ids).toEqual(["OPS-382"]);
    expect(graph.getWorkItemById("OPS-382")).not.toBeNull();
    expect(graph.getWorkItemById("ENG-100")).toBeNull();
    expect(graph.getWorkItemsForThread("t1").map((j) => j.workItemId)).toEqual(["OPS-382"]);

    graph.upsertWorkItem({ id: "ENG-202", source: "jira" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack" });
    expect(linker.linkMessage("Working on OPS-383, same fix as ENG-202", "t2")).toEqual(["OPS-383", "ENG-202"]);
    expect(graph.getWorkItemsForThread("t2").find((j) => j.workItemId === "ENG-202")!.relation).toBe("mentioned");
  });

  it("doesn't create an item for an ID mentioned in a thread that has a ticket of its own", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "OPS-101" });

    const ids = linker.linkMessage("Unblocked by the fix in ENG-202", "t1");

    expect(ids).toEqual([]);
    expect(graph.getWorkItemById("ENG-202")).toBeNull();
    expect(graph.getThreadById("t1")!.workItemId).toBe("OPS-101");
  });

  it("creates the ticket a conversation without one turns out to be about", () => {
    graph.upsertWorkItem({ id: "thread:t1", source: "inferred" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "thread:t1" });

    const ids = linker.linkMessage("Filed this as OPS-101", "t1");

    expect(ids).toEqual(["OPS-101"]);
    expect(graph.getWorkItemById("OPS-101")).not.toBeNull();
  });

  it("doesn't create items for the IDs a digest names, and links those that exist", () => {
    graph.upsertWorkItem({ id: "OPS-102", source: "jira" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Daily summary: OPS-101 merged, OPS-102 in review, ENG-202 blocked", "t1");

    expect(ids).toEqual(["OPS-102"]);
    expect(graph.getWorkItemById("OPS-101")).toBeNull();
    expect(graph.getWorkItemById("ENG-202")).toBeNull();
    expect(graph.getWorkItemsForThread("t1")).toEqual([expect.objectContaining({ workItemId: "OPS-102", relation: "mentioned" })]);
    expect(graph.getThreadById("t1")!.workItemId).toBeNull();
  });

  it("links thread to the first work item", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    linker.linkMessage("Working on OPS-382 and ENG-100", "t1");

    const thread = graph.getThreadById("t1");
    expect(thread!.workItemId).toBe("OPS-382");
  });

  it("does not overwrite existing thread work item link", () => {
    graph.upsertWorkItem({ id: "OPS-1", source: "manual" });
    graph.upsertThread({
      id: "t1",
      channelId: "C1",
      platform: "slack",
      workItemId: "OPS-1",
    });

    linker.linkMessage("Now mentioning OPS-999", "t1");

    const thread = graph.getThreadById("t1");
    // Should keep original link
    expect(thread!.workItemId).toBe("OPS-1");
  });

  it("returns empty array for text with no work item IDs", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Just a regular update, nothing to see", "t1");
    expect(ids).toHaveLength(0);
  });

  it("does not extract PR references — left to LLM classifier", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Submitted PR #716 for review", "t1");
    expect(ids).toHaveLength(0);
  });

  it("extracts only ticket IDs, ignores PR references", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("OPS-382: PR #716 ready for review", "t1");
    expect(ids).toContain("OPS-382");
    expect(ids).not.toContain("PR-716");
    expect(ids).toHaveLength(1);

    // Thread should be linked to OPS-382
    const thread = graph.getThreadById("t1");
    expect(thread!.workItemId).toBe("OPS-382");
  });

  it("does not create duplicate work items on repeated calls", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    linker.linkMessage("Working on OPS-382", "t1");
    linker.linkMessage("Still on OPS-382", "t1");

    // Should still have exactly one work item
    const wi = graph.getWorkItemById("OPS-382");
    expect(wi).not.toBeNull();
  });

  it("works with multiple extractors", () => {
    const extractor1 = new DefaultExtractor({
      ticketPatterns: ["\\b(OPS-\\d+)\\b"],
      prPatterns: [],
    });
    const extractor2 = new DefaultExtractor({
      ticketPatterns: ["\\b(ENG-\\d+)\\b"],
      prPatterns: [],
    });

    const multiLinker = new WorkItemLinker(graph, [extractor1, extractor2]);
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });
    graph.upsertWorkItem({ id: "ENG-2", source: "jira" });

    const ids = multiLinker.linkMessage("OPS-1 and ENG-2", "t1");
    expect(ids).toContain("OPS-1");
    expect(ids).toContain("ENG-2");
  });
});

describe("junction row creation", () => {
  let db: Database;
  let graph: ContextGraph;
  let linker: WorkItemLinker;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    const extractor = new DefaultExtractor(defaultConfig);
    linker = new WorkItemLinker(graph, [extractor]);
    graph.upsertThread({
      id: "T1", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
  });

  afterEach(() => { db.close(); });

  it("creates junction rows for all extracted IDs that are work items", () => {
    graph.upsertWorkItem({ id: "OPS-200", source: "jira" });
    linker.linkMessage("Working on OPS-100 and OPS-200 now", "T1");
    const junctions = graph.getWorkItemsForThread("T1");
    expect(junctions).toHaveLength(2);
    const primary = junctions.find((j) => j.relation === "primary");
    expect(primary).toBeDefined();
    expect(primary!.workItemId).toBe("OPS-100");
    const mentioned = junctions.find((j) => j.relation === "mentioned");
    expect(mentioned).toBeDefined();
    expect(mentioned!.workItemId).toBe("OPS-200");
  });

  it("still sets threads.work_item_id for backwards compatibility", () => {
    linker.linkMessage("Working on OPS-100", "T1");
    const thread = graph.getThreadById("T1");
    expect(thread!.workItemId).toBe("OPS-100");
  });

  it("creates junction row even for single work item", () => {
    linker.linkMessage("Fix OPS-300 urgently", "T1");
    const junctions = graph.getWorkItemsForThread("T1");
    expect(junctions).toHaveLength(1);
    expect(junctions[0].relation).toBe("primary");
  });
});
