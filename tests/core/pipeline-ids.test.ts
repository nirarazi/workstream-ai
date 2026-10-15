import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

describe("Pipeline: model-suggested work item IDs with no ticket prefixes configured", () => {
  it("keeps a link to an existing item an agent created over MCP, and drops technical terms", async () => {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertWorkItem({ id: "deploy-payments", source: "mcp", title: "Deploy payments", currentAtcStatus: "in_progress" });
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [], ticketPrefixes: [] })]);
    const message = {
      id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U-atlas", userName: "Atlas",
      text: "Payments deploy is rolling out; config is UTF-8 now", timestamp: "2026-10-15T05:00:00.000Z", platform: "slack",
    };
    const adapter = {
      name: "fake",
      readThreads: vi.fn(async () => [{ id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
      getThreadMessages: vi.fn(async () => []),
    } as any;
    const classifier = {
      classify: vi.fn(async () => ({
        status: "in_progress", entryType: "progress", confidence: 0.9, reason: "rolling out", workItemIds: ["deploy-payments", "UTF-8"],
        title: "Deploy payments", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
      })),
    } as any;
    const pipeline = new Pipeline(adapter, classifier, graph, linker, undefined, {
      messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 }, taskAdapter: { ticketPrefixes: [] },
    } as any);

    await pipeline.processOnce();

    expect(graph.getEventByMessageId("m1", "T1")!.workItemId).toBe("deploy-payments");
    expect(graph.getWorkItemById("UTF-8")).toBeNull();
    db.close();
  });
});
