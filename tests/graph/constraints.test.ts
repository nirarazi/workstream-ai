// tests/graph/constraints.test.ts — the operator's corrections kept as constraints

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { contradictions, type Constraint } from "../../core/graph/constraints.js";
import { observeSlackMessage } from "../../core/adapters/messaging/slack/observe.js";
import type { Message } from "../../core/types.js";

const workspace = { teamId: "T0NORTHWND", url: null };
const key = (ts: string) => `slack:T0NORTHWND/C0OPS/${ts}`;

function c(id: string, kind: Constraint["kind"], a: string, b: string | null, createdAt: string): Constraint {
  return { id, kind, a, b, decidedBy: "operator", origin: null, createdAt, retiredAt: null, suspendedAt: null, supersededBy: null };
}

describe("contradictions", () => {
  it("suspends the older of a cannot_link and the newest link joining its ends", () => {
    const live = [
      c("1", "must_link", "o1", "o2", "t1"),
      c("2", "must_link", "o2", "o3", "t3"),
      c("3", "cannot_link", "o1", "o3", "t2"),
    ];
    expect(contradictions(live)).toEqual([{ suspend: "3", by: "2" }]);
    // The cannot_link is newest: the link it contradicts is suspended
    expect(contradictions([live[0], live[1], { ...live[2], createdAt: "t4" }])).toEqual([{ suspend: "2", by: "3" }]);
  });

  it("joins through keys: a pin and an alias tie observations together", () => {
    const live = [
      c("1", "pin", "o1", "ticket:OPS-1", "t1"),
      c("2", "key_alias", "ticket:OPS-1", "ticket:OPS-2", "t2"),
      c("3", "pin", "o2", "ticket:OPS-2", "t3"),
      c("4", "cannot_link", "o1", "o2", "t4"),
    ];
    expect(contradictions(live)).toEqual([{ suspend: "3", by: "4" }]);
    expect(contradictions(live.slice(0, 2).concat(live[3]))).toEqual([]);
  });
});

describe("constraints from operator actions", () => {
  let db: Database;
  let graph: ContextGraph;

  /** A message in a thread, observed and classified into an item */
  function said(threadId: string, ts: string, itemId: string | null): void {
    graph.upsertThread({ id: threadId, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: itemId });
    const message = { id: ts, threadId, channelId: "C0OPS", channelName: "ops", userId: "U0ATLAS", userName: "Atlas",
      text: "update", timestamp: `2026-10-19T0${ts.slice(-1)}:00:00.000Z`, platform: "slack" } as Message;
    graph.recordObservation(observeSlackMessage(message, workspace)!);
    graph.insertEvent({ threadId, messageId: ts, workItemId: itemId, status: "in_progress", confidence: 0.9, timestamp: message.timestamp });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => db.close());

  it("keeps a merge of two ticketed items as a key alias, retired by the unmerge", () => {
    graph.upsertWorkItem({ id: "OPS-1", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira" });
    graph.mergeWorkItems("OPS-1", "OPS-2");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.b, x.origin])).toEqual([["key_alias", "ticket:OPS-1", "ticket:OPS-2", "merge:OPS-1"]]);
    graph.unmergeWorkItem("OPS-1");
    expect(graph.constraints.live()).toEqual([]);
  });

  it("ties a merged conversation's messages to the ticket it went into", () => {
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira" });
    said("T1", "1700000000.000001", "thread:T1");
    said("T1", "1700000000.000002", "thread:T1");
    graph.mergeWorkItems("thread:T1", "OPS-2");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.b]).sort()).toEqual([
      ["pin", key("1700000000.000001"), "ticket:OPS-2"],
      ["pin", key("1700000000.000002"), "ticket:OPS-2"],
    ]);
  });

  it("ties two conversations by the target's anchor when neither has a key", () => {
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    graph.upsertWorkItem({ id: "thread:T2", source: "inferred" });
    said("T1", "1700000000.000001", "thread:T1");
    said("T2", "1700000000.000002", "thread:T2");
    graph.mergeWorkItems("thread:T1", "thread:T2");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.b])).toEqual([["must_link", key("1700000000.000001"), key("1700000000.000002")]]);
  });

  it("pins a manually linked thread's root to the item's key; unlinking retires it and keeps them apart", () => {
    graph.upsertWorkItem({ id: "OPS-2", source: "jira" });
    said("T0", "1700000000.000001", "OPS-2");
    said("T1", "1700000000.000002", null);
    graph.linkThread("T1", "OPS-2");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.b, x.origin])).toEqual([["pin", key("1700000000.000002"), "ticket:OPS-2", "link:T1"]]);
    graph.unlinkThread("T1");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.b, x.origin])).toEqual([
      ["cannot_link", key("1700000000.000001"), key("1700000000.000002"), "unlink:T1"],
    ]);
  });

  it("marks an item's observations not an item when the operator calls it noise", () => {
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    said("T1", "1700000000.000001", "thread:T1");
    graph.markNotAnItem("thread:T1");
    expect(graph.constraints.live().map((x) => [x.kind, x.a, x.origin])).toEqual([["not_an_item", key("1700000000.000001"), "noise:thread:T1"]]);
  });

  it("keeps apart what the operator unmerged after the tracker merged it", () => {
    graph.upsertWorkItem({ id: "OPS-102", source: "extracted" });
    said("T1", "1700000000.000001", "OPS-102");
    graph.upsertWorkItem({ id: "OPS-101", source: "jira" });
    said("T0", "1700000000.000002", "OPS-101");
    graph.foldIntoTrackerItem("OPS-102", "OPS-101", "hierarchy", "jira");
    expect(graph.constraints.live()).toEqual([]); // the tracker's fold isn't a correction
    graph.unmergeWorkItem("OPS-102");
    expect(graph.constraints.live().map((x) => [x.kind, x.origin])).toEqual([["cannot_link", "unmerge:OPS-102"]]);
  });

  it("backfills earlier merges and manual links once, and never revives one that was undone", () => {
    graph.upsertWorkItem({ id: "OPS-1", source: "jira" });
    graph.upsertWorkItem({ id: "OPS-2", source: "jira" });
    graph.upsertWorkItem({ id: "thread:T1", source: "inferred" });
    said("T1", "1700000000.000001", "thread:T1");
    graph.mergeWorkItems("OPS-1", "OPS-2");
    graph.mergeWorkItems("thread:T1", "OPS-2");
    graph.linkThread("T1", "OPS-2");
    // As if they were made before constraints existed
    db.db.exec("DELETE FROM constraints");

    expect(graph.backfillConstraints()).toBe(3);
    expect(graph.constraints.live().map((x) => [x.kind, x.decidedBy, x.origin]).sort()).toEqual([
      ["key_alias", "backfill", "merge:OPS-1"],
      ["pin", "backfill", "link:T1"],
      ["pin", "backfill", "merge:thread:T1"],
    ]);
    expect(graph.backfillConstraints()).toBe(0);
    graph.unmergeWorkItem("OPS-1");
    expect(graph.backfillConstraints()).toBe(0);
  });
});
