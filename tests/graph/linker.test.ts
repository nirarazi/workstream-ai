// tests/graph/linker.test.ts — Work item linker tests

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

const defaultConfig = {
  ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
  prPatterns: ["PR\\s*#?(\\d+)", "#(\\d+)"],
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

  it("handles PR references", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("Submitted PR #716 for review", "t1");
    expect(ids).toContain("PR-716");

    const wi = graph.getWorkItemById("PR-716");
    expect(wi).not.toBeNull();
  });

  it("handles mixed ticket and PR references", () => {
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack" });

    const ids = linker.linkMessage("AI-382: PR #716 ready for review", "t1");
    expect(ids).toContain("AI-382");
    expect(ids).toContain("PR-716");

    // Thread should be linked to first ID (AI-382)
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
