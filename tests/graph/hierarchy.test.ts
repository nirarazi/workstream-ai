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
    expect(belongsTo(detail({ itemType: epic, duplicates: ["OPS-1"] }))).toBeNull(); // a container is never folded
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

  it("keeps a sub-task's ask in front of the operator when it's folded into a quiet or finished parent", () => {
    graph.upsertWorkItem({ id: "OPS-102", source: "extracted", currentAtcStatus: "blocked_on_human", currentConfidence: 0.9, statusAt: "2026-10-19T10:00:00.000Z" });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", currentAtcStatus: "completed", currentConfidence: 0.9, statusAt: "2026-10-19T09:00:00.000Z" });
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    const parent = graph.getWorkItemById("OPS-101")!;
    expect(parent.currentAtcStatus).toBe("blocked_on_human");
    expect(parent.reopenedAt).toBe("2026-10-19T10:00:00.000Z");
  });

  it("doesn't let an older update from a sub-task overwrite its parent's newer ask", () => {
    graph.upsertWorkItem({ id: "OPS-102", source: "extracted", currentAtcStatus: "in_progress", statusAt: "2026-10-19T09:00:00.000Z" });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", currentAtcStatus: "needs_decision", statusAt: "2026-10-19T10:00:00.000Z" });
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    expect(graph.getWorkItemById("OPS-101")!.currentAtcStatus).toBe("needs_decision");
  });

  it("doesn't fold again once the operator has undone it", () => {
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    graph.unmergeWorkItem("OPS-102");
    expect(graph.resolveItemRef("OPS-102")).toBe("OPS-102");
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira")).toBe("OPS-102");
    expect(graph.getWorkItemById("OPS-102")!.mergedInto).toBeNull();
  });

  it("doesn't fold again after an unmerge when the parent's ticket resolves to another item", () => {
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-200", source: "jira" });
    graph.mergeWorkItems("OPS-101", "OPS-200");
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira")).toBe("OPS-200");
    graph.unmergeWorkItem("OPS-102");
    expect(graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira")).toBe("OPS-102");
  });

  it("knows a folded sub-task's id as a step of its parent, and an operator merge as not one", () => {
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    expect(graph.isStepRef("OPS-102")).toBe(true);
    expect(graph.isStepRef("OPS-101")).toBe(false);
    graph.upsertWorkItem({ id: "OPS-300", source: "jira" });
    graph.mergeWorkItems("OPS-300", "OPS-101");
    expect(graph.isStepRef("OPS-300")).toBe(false);
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
