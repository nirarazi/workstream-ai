import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

const at = (min: number) => new Date(Date.UTC(2026, 9, 14, 5, min)).toISOString();

describe("Needs me follows the latest confident blocking message", () => {
  let db: Database;
  let graph: ContextGraph;
  let n = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "agent-1", name: "Atlas", platform: "slack", platformUserId: "U001" });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Payment links", currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T1", channelId: "C001", channelName: "strategy", platform: "slack", workItemId: "OPS-101" });
  });

  afterEach(() => {
    db.close();
  });

  function message(min: number, status: string, confidence: number, forOperator: boolean, actionRequiredFrom?: string[]) {
    graph.insertEvent({
      threadId: "T1", messageId: `m${n++}`, workItemId: "OPS-101", agentId: "agent-1",
      status: status as any, confidence, reason: "", rawText: "", timestamp: at(min),
      entryType: "block", targetedAtOperator: forOperator, actionRequiredFrom,
    });
  }
  const inNeedsMe = () => graph.getActionableItems().some((i) => i.workItem.id === "OPS-101");
  const inAllActive = () => graph.getAllActiveItems().some((i) => i.workItem.id === "OPS-101");

  it("drops an item once a later block confidently says it's waiting on someone else", () => {
    message(26, "blocked_on_human", 0.31, true); // "Dana owns the payment-link gap"
    message(52, "blocked_on_human", 0.87, false); // "correction: it's waiting on Alex Rivera"
    expect(inNeedsMe()).toBe(false);
    expect(inAllActive()).toBe(true);
  });

  it("keeps it when the hand-off is below the minimum confidence", () => {
    message(26, "blocked_on_human", 0.9, true);
    message(55, "blocked_on_human", 0.36, false);
    expect(inNeedsMe()).toBe(true);
  });

  it("keeps it when later messages are progress or chatter, not a block on someone else", () => {
    message(26, "blocked_on_human", 0.9, true);
    message(40, "in_progress", 0.95, false);
    message(45, "noise", 0.99, false);
    expect(inNeedsMe()).toBe(true);
  });

  it("brings it back when a newer message asks the operator again", () => {
    message(26, "blocked_on_human", 0.9, true);
    message(52, "needs_decision", 0.8, false);
    message(58, "blocked_on_human", 0.7, true);
    expect(inNeedsMe()).toBe(true);
  });

  it("isn't a hand-off when the block still names the operator, by ID or by name", () => {
    // Older classifications sometimes named the operator as "dana" and were stored as not theirs
    message(26, "blocked_on_human", 0.9, true);
    message(30, "blocked_on_human", 0.95, false, ["dana"]);
    message(35, "blocked_on_human", 0.95, false, ["U0OPERATOR1", "U0OTHER"]);
    expect(graph.getActionableItems(0.6, ["U0OPERATOR1", "Dana"]).length).toBe(1);
    message(40, "blocked_on_human", 0.95, false, ["U0OTHER"]);
    expect(graph.getActionableItems(0.6, ["U0OPERATOR1", "Dana"]).length).toBe(0);
  });

  it("uses the configured minimum", () => {
    message(26, "blocked_on_human", 0.9, true);
    message(52, "blocked_on_human", 0.5, false);
    expect(graph.getActionableItems(0.6).length).toBe(1);
    expect(graph.getActionableItems(0.4).length).toBe(0);
  });
});
