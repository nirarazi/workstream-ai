import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { buildUnifiedStatus, buildTimeline } from "../../core/stream.js";
import type { Event, WorkItem, OperatorIdentityMap } from "../../core/types.js";

describe("Stream", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("buildUnifiedStatus", () => {
    it("shows waiting time for blocked items with neutral label when actor unknown", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs approval", rawText: "Please approve",
        timestamp: new Date(Date.now() - 130 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: null,
        nextAction: null,
      };
      const result = buildUnifiedStatus(workItem, blockEvent);
      expect(result).toMatch(/^Blocked · 2h \d+m$/);
    });

    it("shows label without time for in_progress items", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "in_progress", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      expect(buildUnifiedStatus(workItem, null)).toBe("In progress");
    });
  });

  describe("buildTimeline", () => {
    it("filters noise and sorts newest first", () => {
      const events: Event[] = [
        { id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1", status: "in_progress", confidence: 0.9, reason: "Started work", rawText: "Starting", timestamp: "2026-04-15T10:00:00Z", createdAt: "2026-04-15T10:00:00Z", entryType: "progress", targetedAtOperator: true, actionRequiredFrom: null, nextAction: null },
        { id: "e2", threadId: "t1", messageId: "m2", workItemId: "AI-100", agentId: "a1", status: "noise", confidence: 0.8, reason: "Status update", rawText: "Still working", timestamp: "2026-04-15T11:00:00Z", createdAt: "2026-04-15T11:00:00Z", entryType: "noise", targetedAtOperator: true, actionRequiredFrom: null, nextAction: null },
        { id: "e3", threadId: "t2", messageId: "m3", workItemId: "AI-100", agentId: null, status: "completed", confidence: 1.0, reason: "Operator approved", rawText: "Looks good", timestamp: "2026-04-15T12:00:00Z", createdAt: "2026-04-15T12:00:00Z", entryType: "decision", targetedAtOperator: true, actionRequiredFrom: null, nextAction: null },
      ];
      const agentMap = new Map([["a1", "Byte"]]);
      const threadChannelMap = new Map([["t1", "#agent-orchestrator"], ["t2", "#strategy"]]);
      const timeline = buildTimeline(events, agentMap, threadChannelMap);
      expect(timeline).toHaveLength(2);
      expect(timeline[0].entryType).toBe("decision");
      expect(timeline[0].isOperator).toBe(true);
      expect(timeline[0].channelName).toBe("#strategy");
      expect(timeline[1].entryType).toBe("progress");
      expect(timeline[1].agentName).toBe("Byte");
    });
  });

  describe("targetedAtOperator filtering", () => {
    it("filters inbox items by targetedAtOperator", () => {
      // Set up agents
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });

      // Work item blocked on operator (targeted_at_operator = true)
      graph.upsertWorkItem({
        id: "AI-1", source: "jira", title: "Needs operator approval",
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
      });
      graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
      graph.insertEvent({
        threadId: "t1", messageId: "m1", workItemId: "AI-1", agentId: "a1",
        status: "blocked_on_human", confidence: 0.9, reason: "Needs operator approval",
        timestamp: "2026-04-15T10:00:00Z", targetedAtOperator: true,
      });

      // Work item blocked on someone else (targeted_at_operator = false)
      graph.upsertWorkItem({
        id: "AI-2", source: "jira", title: "Blocked on Guy",
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.85,
      });
      graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
      graph.insertEvent({
        threadId: "t2", messageId: "m2", workItemId: "AI-2", agentId: "a1",
        status: "blocked_on_human", confidence: 0.85, reason: "Blocked on Guy's review",
        timestamp: "2026-04-15T11:00:00Z", targetedAtOperator: false,
      });

      // getActionableItems should only return the operator-targeted item
      const actionable = graph.getActionableItems();
      expect(actionable).toHaveLength(1);
      expect(actionable[0].workItem.id).toBe("AI-1");

      // getFleetItems should return both (no targetedAtOperator filter)
      const fleet = graph.getFleetItems();
      const ids = fleet.map((i) => i.workItem.id);
      expect(ids).toContain("AI-1");
      expect(ids).toContain("AI-2");
    });
  });

  describe("nextAction in stream data", () => {
    it("nextAction is available from event when blocked", () => {
      graph.upsertWorkItem({
        id: "AI-300", source: "jira", title: "Blocked task",
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
      });
      graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-300" });
      graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
      graph.insertEvent({
        threadId: "t1", messageId: "m1", workItemId: "AI-300", agentId: "a1",
        status: "blocked_on_human", confidence: 0.9, reason: "Needs approval",
        rawText: "Please approve", timestamp: new Date().toISOString(),
        targetedAtOperator: true,
        actionRequiredFrom: ["U_OPERATOR"],
        nextAction: "Approve PR #716",
      });

      // Verify the event has nextAction after round-trip through graph
      const events = graph.getEventsForWorkItem("AI-300");
      const blockEvent = events.find(e => e.status === "blocked_on_human");
      expect(blockEvent).toBeDefined();
      expect(blockEvent!.nextAction).toBe("Approve PR #716");
      expect(blockEvent!.actionRequiredFrom).toEqual(["U_OPERATOR"]);
    });
  });

  describe("buildUnifiedStatus actor-aware labels", () => {
    it("shows 'Waiting on you' when operator is in actionRequiredFrom", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs approval", rawText: "Please approve",
        timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: ["U_OPERATOR"],
        nextAction: "Approve PR #716",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["a1", "Byte"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on you · \d+m/);
    });

    it("shows actor name when someone else is in actionRequiredFrom", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs Guy's review", rawText: "Waiting for Guy",
        timestamp: new Date(Date.now() - 130 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_GUY123"],
        nextAction: "Review PR #716",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["U_GUY123", "Guy"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on Guy · 2h \d+m/);
    });

    it("shows 'Needs your decision' when operator is action taker for needs_decision", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "needs_decision", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "needs_decision", confidence: 0.9,
        reason: "Choose palette", rawText: "Pick a color",
        timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: ["U_OPERATOR"],
        nextAction: "Choose between 3 palette options",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Needs your decision · \d+m/);
    });

    it("shows actor name for needs_decision when someone else", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "needs_decision", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "needs_decision", confidence: 0.9,
        reason: "Guy needs to decide", rawText: "Decision needed",
        timestamp: new Date(Date.now() - 90 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_GUY123"],
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["U_GUY123", "Guy"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Needs Guy's decision · 1h \d+m/);
    });

    it("falls back to neutral 'Blocked' label when actionRequiredFrom is null", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs approval", rawText: "Please approve",
        timestamp: new Date(Date.now() - 5 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: null,
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map();
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/^Blocked · \d+m$/);
    });

    it("uses raw user ID when name cannot be resolved", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs review", rawText: "Please review",
        timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_UNKNOWN"],
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on U_UNKNOWN · \d+m/);
    });
  });

  describe("multi-agent multi-thread aggregation", () => {
    it("getAgentsForWorkItem returns all agents who have events", () => {
      graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Test" });
      graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-100" });
      graph.upsertThread({ id: "t2", channelId: "C2", channelName: "strategy", platform: "slack", workItemId: "AI-100" });
      const agent1 = graph.upsertAgent({ name: "Byte", platform: "slack", platformUserId: "U1" });
      const agent2 = graph.upsertAgent({ name: "Pixel", platform: "slack", platformUserId: "U2" });
      graph.insertEvent({ threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: agent1.id, status: "in_progress", confidence: 0.9, timestamp: new Date().toISOString(), entryType: "progress" });
      graph.insertEvent({ threadId: "t2", messageId: "m2", workItemId: "AI-100", agentId: agent2.id, status: "blocked_on_human", confidence: 0.9, timestamp: new Date().toISOString(), entryType: "block" });
      const agents = graph.getAgentsForWorkItem("AI-100");
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name).sort()).toEqual(["Byte", "Pixel"]);
    });

    it("getChannelsForWorkItem returns all channels", () => {
      graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Test" });
      graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-100" });
      graph.upsertThread({ id: "t2", channelId: "C2", channelName: "strategy", platform: "slack", workItemId: "AI-100" });
      const channels = graph.getChannelsForWorkItem("AI-100");
      expect(channels).toHaveLength(2);
      expect(channels.map((c) => c.name).sort()).toEqual(["orchestrator", "strategy"]);
    });
  });
});
