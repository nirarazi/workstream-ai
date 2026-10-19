// tests/core/pipeline-hierarchy.test.ts — a sub-task's messages join its parent's item once the tracker says so

import { describe, it, expect, vi, onTestFinished } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import type { Classification, Message, Thread, WorkItemDetail } from "../../core/types.js";

const IN_PROGRESS: Classification = {
  status: "in_progress", entryType: "progress", confidence: 0.9, reason: "working", workItemIds: [], title: "Export step",
  targetedAtOperator: false, actionRequiredFrom: null, nextAction: null,
};

function detail(over: Partial<WorkItemDetail>): WorkItemDetail {
  return { id: "OPS-102", title: "Export step", status: "In Progress", assignee: null, url: null, labels: [], description: null, ...over };
}

function setup(itemTypeRoles: unknown[] = []) {
  const db = new Database(":memory:");
  onTestFinished(() => db.close());
  const graph = new ContextGraph(db);
  const message = {
    id: "m1", threadId: "T1", channelId: "C1", channelName: "fleet-ops", userId: "U0ATLAS", userName: "Atlas",
    text: "Started OPS-102", timestamp: new Date().toISOString(), platform: "slack",
  } as Message;
  const thread: Thread = { id: "T1", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null, lastActivity: message.timestamp, messageCount: 1, messages: [message] };
  const tracker = {
    name: "jira",
    getWorkItem: vi.fn(async (key: string) => key === "OPS-102"
      ? detail({ itemType: { id: "10003", name: "Sub-task", hierarchyLevel: -1 }, parent: { key: "OPS-101", title: "Export" } })
      : null),
  };
  const config = { messaging: { pollInterval: 3600, channels: [] }, lookback: { maxThreadsPerPoll: 10, maxActiveThreadRepolls: 0 },
    taskAdapter: { enabled: true, ticketPrefixes: [], itemTypeRoles } } as any;
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] })]);
  const adapter = { name: "fake", readThreads: vi.fn(async () => [thread]), getThreadMessages: vi.fn(async () => []) };
  let answer = IN_PROGRESS;
  const pipeline = new Pipeline(adapter as any, { classify: vi.fn(async () => answer) } as any, graph, linker, tracker as any, config);
  return { graph, pipeline: Object.assign(pipeline, { setClassification: (c: Classification) => { answer = c; } }), tracker, thread };
}

describe("Pipeline: tracker hierarchy", () => {
  it("folds a sub-task's item into its parent's, without overwriting the parent with the sub-task's details", async () => {
    const { graph, pipeline } = setup();
    await pipeline.processOnce();
    expect(graph.getThreadById("T1")!.workItemId).toBe("OPS-101");
    expect(graph.getWorkItemById("OPS-101")!.title).toBe("Export");
    expect(graph.getWorkItemById("OPS-102")!.mergedInto).toBe("OPS-101");
    expect(graph.getEventsForWorkItem("OPS-101").map((e) => e.messageId)).toEqual(["m1"]);
  });

  it("counts a step's done as progress on the case, not the case done", async () => {
    const { graph, pipeline, thread } = setup();
    await pipeline.processOnce();
    // The sub-task is folded; then an agent says the sub-task is done
    const done = { ...thread.messages[0], id: "m2", text: "OPS-102 done", timestamp: new Date(Date.now() + 1000).toISOString() };
    thread.messages = [done];
    thread.id = "T2";
    done.threadId = "T2";
    pipeline.setClassification({ ...IN_PROGRESS, status: "completed", entryType: "progress" });
    await pipeline.processOnce();
    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBe("in_progress");
  });

  it("keeps a sub-task its own case when the operator says its type is a case", async () => {
    const { graph, pipeline } = setup([{ typeId: "10003", role: "case" }]);
    await pipeline.processOnce();
    expect(graph.getThreadById("T1")!.workItemId).toBe("OPS-102");
    expect(graph.getWorkItemById("OPS-102")!.title).toBe("Export step");
    expect(graph.getWorkItemById("OPS-101")).toBeNull();
  });
});
