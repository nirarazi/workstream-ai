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

  it("creates work items for extracted IDs", () => {
    // Create a thread first
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Working on AI-382 and IT-100", "t1");

    expect(ids).toContain("AI-382");
    expect(ids).toContain("IT-100");

    // Work items should exist in the graph
    const wi1 = graph.getWorkItemById("AI-382");
    expect(wi1).not.toBeNull();
    expect(wi1!.source).toBe("extracted");

    const wi2 = graph.getWorkItemById("IT-100");
    expect(wi2).not.toBeNull();
  });

  it("links thread to the first work item", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    linker.linkMessage("Working on AI-382 and IT-100", "t1");

    const thread = graph.getThreadById("t1");
    expect(thread!.workItemId).toBe("AI-382");
  });

  it("does not overwrite existing thread work item link", () => {
    graph.upsertWorkItem({ id: "AI-1", source: "manual" });
    graph.upsertThread({
      id: "t1",
      channelId: "C1",
      platform: "slack",
      workItemId: "AI-1",
    });

    linker.linkMessage("Now mentioning AI-999", "t1");

    const thread = graph.getThreadById("t1");
    // Should keep original link
    expect(thread!.workItemId).toBe("AI-1");
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

    const ids = linker.linkMessage("AI-382: PR #716 ready for review", "t1");
    expect(ids).toContain("AI-382");
    expect(ids).not.toContain("PR-716");
    expect(ids).toHaveLength(1);

    // Thread should be linked to AI-382
    const thread = graph.getThreadById("t1");
    expect(thread!.workItemId).toBe("AI-382");
  });

  it("does not create duplicate work items on repeated calls", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    linker.linkMessage("Working on AI-382", "t1");
    linker.linkMessage("Still on AI-382", "t1");

    // Should still have exactly one work item
    const wi = graph.getWorkItemById("AI-382");
    expect(wi).not.toBeNull();
  });

  it("works with multiple extractors", () => {
    const extractor1 = new DefaultExtractor({
      ticketPatterns: ["\\b(AI-\\d+)\\b"],
      prPatterns: [],
    });
    const extractor2 = new DefaultExtractor({
      ticketPatterns: ["\\b(IT-\\d+)\\b"],
      prPatterns: [],
    });

    const multiLinker = new WorkItemLinker(graph, [extractor1, extractor2]);
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = multiLinker.linkMessage("AI-1 and IT-2", "t1");
    expect(ids).toContain("AI-1");
    expect(ids).toContain("IT-2");
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

  it("creates junction rows for all extracted IDs", () => {
    linker.linkMessage("Working on AI-100 and AI-200 now", "T1");
    const junctions = graph.getWorkItemsForThread("T1");
    expect(junctions).toHaveLength(2);
    const primary = junctions.find((j) => j.relation === "primary");
    expect(primary).toBeDefined();
    expect(primary!.workItemId).toBe("AI-100");
    const mentioned = junctions.find((j) => j.relation === "mentioned");
    expect(mentioned).toBeDefined();
    expect(mentioned!.workItemId).toBe("AI-200");
  });

  it("still sets threads.work_item_id for backwards compatibility", () => {
    linker.linkMessage("Working on AI-100", "T1");
    const thread = graph.getThreadById("T1");
    expect(thread!.workItemId).toBe("AI-100");
  });

  it("creates junction row even for single work item", () => {
    linker.linkMessage("Fix AI-300 urgently", "T1");
    const junctions = graph.getWorkItemsForThread("T1");
    expect(junctions).toHaveLength(1);
    expect(junctions[0].relation).toBe("primary");
  });
});
