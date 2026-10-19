// tests/graph/hierarchy.test.ts — item type roles, and folding sub-tasks and duplicates into their items

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { belongsTo, roleOf } from "../../core/graph/hierarchy.js";
import type { WorkItemDetail } from "../../core/types.js";

const epic = { id: "10000", name: "Epic", hierarchyLevel: 1 };
const story = { id: "10001", name: "Feature", hierarchyLevel: 0 };
const subtask = { id: "10003", name: "Step", hierarchyLevel: -1 };

function detail(over: Partial<WorkItemDetail>): WorkItemDetail {
  return { id: "OPS-102", title: "Export step", status: "In Progress", assignee: null, url: null, labels: [], description: null, ...over };
}

describe("roleOf", () => {
  it("reads the role from the hierarchy level, whatever the type is called", () => {
    expect(roleOf(epic, "OPS")).toBe("container");
    expect(roleOf(story, "OPS")).toBe("case");
    expect(roleOf(subtask, "OPS")).toBe("step");
    expect(roleOf({ id: "1", name: "Custom", hierarchyLevel: null }, "OPS")).toBe("case");
  });

  it("lets the operator's override win, a project's over one for every project", () => {
    const overrides = [{ typeId: "10003", role: "case" as const }, { typeId: "10003", role: "step" as const, project: "ops" }];
    expect(roleOf(subtask, "ENG", overrides)).toBe("case");
    expect(roleOf(subtask, "OPS", overrides)).toBe("step");
    expect(roleOf({ ...subtask, name: "Renamed" }, "ENG", overrides)).toBe("case");
  });
});

describe("belongsTo", () => {
  it("puts a step in its parent and a duplicate in its original, and nothing else anywhere", () => {
    expect(belongsTo(detail({ itemType: subtask, parent: { key: "OPS-101" } }))).toEqual({ key: "OPS-101", reason: "step" });
    expect(belongsTo(detail({ itemType: story, parent: { key: "OPS-1" } }))).toBeNull(); // a story in an epic
    expect(belongsTo(detail({ itemType: story, duplicates: ["OPS-100"] }))).toEqual({ key: "OPS-100", reason: "duplicate" });
    expect(belongsTo(detail({ itemType: subtask, parent: { key: "OPS-101" } }), [{ typeId: "10003", role: "case" }])).toBeNull();
  });
});

describe("foldIntoTrackerItem", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertThread({ id: "T1", channelId: "C1", channelName: "ops", platform: "slack", workItemId: null });
    graph.upsertWorkItem({ id: "OPS-102", source: "extracted" });
    graph.upsertThread({ id: "T1", channelId: "C1", platform: "slack", workItemId: "OPS-102" });
    graph.insertEvent({ threadId: "T1", messageId: "m1", workItemId: "OPS-102", status: "in_progress", confidence: 0.9, timestamp: "t" });
  });

  afterEach(() => db.close());

  it("merges a sub-task's item into its parent's, making the parent's item if it's new", () => {
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira", "Export")).toBe("OPS-101");
    expect(graph.getWorkItemById("OPS-101")!.title).toBe("Export");
    expect(graph.getEventsForWorkItem("OPS-101").map((e) => e.messageId)).toEqual(["m1"]);
    expect(graph.resolveItemRef("OPS-102")).toBe("OPS-101");
  });

  it("doesn't fold again once the operator has undone it", () => {
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    graph.unmergeWorkItem("OPS-102");
    expect(graph.resolveItemRef("OPS-102")).toBe("OPS-102");
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira")).toBe("OPS-102");
    expect(graph.getWorkItemById("OPS-102")!.mergedInto).toBeNull();
  });

  it("leaves an item the operator merged the ticket into as it is", () => {
    graph.upsertWorkItem({ id: "thread:T9", source: "inferred" });
    graph.mergeWorkItems("OPS-102", "thread:T9");
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira")).toBe("thread:T9");
    expect(graph.getWorkItemById("thread:T9")!.mergedInto).toBeNull();
  });

  it("an undone operator merge isn't recorded as a refusal", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.mergeWorkItems("OPS-102", "OPS-101");
    graph.unmergeWorkItem("OPS-102");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM declined_merges").get()).toEqual({ n: 0 });
  });
});
