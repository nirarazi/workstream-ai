import { describe, it, expect, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { Pipeline } from "../../core/pipeline.js";
import type { Classification, Message } from "../../core/types.js";

function setup() {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifyFn = vi.fn().mockResolvedValue({
    status: "in_progress", confidence: 0.9, reason: "working", workItemIds: [], title: "test",
  });
  const classifier = new Classifier(
    { name: "mock", classify: classifyFn },
    "sys", [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] }),
  ]);

  const adapter = { name: "test", displayName: "Test" } as any;
  const pipeline = new Pipeline(adapter, classifier, graph, linker);

  return { db, graph, classifier, classifyFn, linker, pipeline };
}

describe("Pipeline optimizations", () => {
  it("skips classification when work item is completed", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    graph.upsertWorkItem({ id: "AI-100", source: "jira", currentAtcStatus: "completed" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "test", workItemId: "AI-100" });

    const msg: Message = {
      id: "m-new",
      text: "AI-100: Confirming deployment is stable",
      userId: "u1",
      userName: "Byte",
      platform: "test",
      timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg, "t1", "C1");

    expect(classifyFn).not.toHaveBeenCalled();
    db.close();
  });

  it("skips classification for duplicate message content within same thread", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    graph.upsertWorkItem({ id: "AI-200", source: "jira" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "test", workItemId: "AI-200" });

    const msg1: Message = {
      id: "m1", text: "Still working on AI-200...", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };
    const msg2: Message = {
      id: "m2", text: "Still working on AI-200...", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg1, "t2", "C1");
    await pipeline.processMessage(msg2, "t2", "C1");

    expect(classifyFn).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("classifies normally when work item is not completed", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    graph.upsertWorkItem({ id: "AI-300", source: "jira", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t3", channelId: "C1", platform: "test", workItemId: "AI-300" });

    const msg: Message = {
      id: "m3", text: "AI-300: Need approval for this PR", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg, "t3", "C1");
    expect(classifyFn).toHaveBeenCalledTimes(1);
    db.close();
  });
});
