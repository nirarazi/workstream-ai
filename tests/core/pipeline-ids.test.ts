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

describe("Pipeline: ticket prefixes learned from the task tracker", () => {
  function setup(trackerPrefixes: string[], configured: string[] = []) {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [], ticketPrefixes: [] })]);
    const message = {
      id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U-relay", userName: "Relay",
      text: "OPS-12 is waiting on PR #42; CRM ref Q-456", timestamp: "2026-10-15T05:00:00.000Z", platform: "slack",
    };
    const adapter = {
      name: "fake",
      readThreads: vi.fn(async () => [{ id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] }]),
      getThreadMessages: vi.fn(async () => []),
    } as any;
    const classifier = {
      classify: vi.fn(async () => ({
        status: "in_progress", entryType: "progress", confidence: 0.9, reason: "waiting on review", workItemIds: ["OPS-12", "PR #42", "Q-456"],
        title: "Rollout", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
      })),
    } as any;
    const tracker = { getValidIdPrefixes: () => trackerPrefixes } as any;
    const pipeline = new Pipeline(adapter, classifier, graph, linker, tracker, {
      messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 }, taskAdapter: { ticketPrefixes: configured },
    } as any);
    return { db, graph, classifier, pipeline };
  }

  it("keeps the tracker's tickets and pull requests, drops other keys, and names them in the prompt", async () => {
    const { db, graph, classifier, pipeline } = setup(["OPS-"]);

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-12")).not.toBeNull();
    expect(graph.getWorkItemById("Q-456")).toBeNull();
    expect(graph.getWorkItemById("PR #42")).not.toBeNull();
    expect(classifier.classify.mock.calls[0][4]).toEqual(["OPS-", "PR #"]);
    db.close();
  });

  it("still leaves pull requests out when the operator configured prefixes without them", async () => {
    const { db, graph, classifier, pipeline } = setup(["OPS-"], ["ENG-"]);

    await pipeline.processOnce();

    expect(classifier.classify.mock.calls[0][4]).toEqual(["ENG-", "OPS-"]);
    expect(graph.getWorkItemById("OPS-12")).not.toBeNull();
    expect(graph.getWorkItemById("PR #42")).toBeNull();
    db.close();
  });

  it("drops a model-suggested ID that starts with a known prefix but has no number after it", async () => {
    const { db, graph, classifier, pipeline } = setup(["OPS-"]);
    classifier.classify.mockImplementation(async () => ({
      status: "in_progress", entryType: "progress", confidence: 0.9, reason: "planning", workItemIds: ["OPS-Rollout", "OPS-31"],
      title: "Rollout plan", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
    }));

    await pipeline.processOnce();

    expect(graph.getWorkItemById("OPS-Rollout")).toBeNull();
    expect(graph.getWorkItemById("OPS-31")).not.toBeNull();
    db.close();
  });

  it("leaves a long project list out of the prompt, and still filters with it", async () => {
    const many = Array.from({ length: 31 }, (_, i) => `P${String.fromCharCode(65 + (i % 26))}${i}-`);
    const { db, graph, classifier, pipeline } = setup([...many, "OPS-"]);

    await pipeline.processOnce();

    expect(classifier.classify.mock.calls[0][4]).toEqual([]);
    expect(graph.getWorkItemById("OPS-12")).not.toBeNull();
    expect(graph.getWorkItemById("Q-456")).toBeNull();
    db.close();
  });
});

