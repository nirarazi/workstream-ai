// tests/grouping/lab.test.ts — the grouping lab: streams, cases and a case's graph, read from the database

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { GroupingLab } from "../../core/grouping/lab.js";
import { createApp } from "../../core/server.js";

describe("GroupingLab", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U0ATLAS", name: "Atlas", platform: "slack", platformUserId: "U0ATLAS", isBot: true });
    graph.upsertAgent({ id: "U0DANA", name: "Dana", platform: "slack", platformUserId: "U0DANA", isBot: false });
    const say = (thread: string, ts: string, agent: string, text: string, minute: number) => {
      graph.upsertThread({ id: thread, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
      graph.insertEvent({ threadId: thread, messageId: ts, agentId: agent, status: "in_progress", confidence: 0.9, rawText: text,
        timestamp: new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString() });
    };
    say("1700000001.000100", "1700000001.000100", "U0ATLAS", "OPS-101: started the Northwind export", 0);
    say("1700000001.000100", "1700000002.000100", "U0DANA", "Can you add the Contoso fields too?", 5);
    say("1700000003.000100", "1700000003.000100", "U0ATLAS", "OPS-101 deployed", 30);
  });

  afterEach(() => db.close());

  it("groups the database's messages into cases and streams, and draws a case's edges", () => {
    const lab = new GroupingLab(db.db);
    const { streams } = lab.streams();
    expect(streams.map((s) => s.key)).toEqual(["project:OPS"]);
    const stream = lab.stream("project:OPS")!;
    expect(stream.cases).toHaveLength(1);
    const kase = lab.case(stream.cases[0].id)!;
    expect(kase.nodes.map((n) => n.text)).toEqual(["OPS-101: started the Northwind export", "Can you add the Contoso fields too?", "OPS-101 deployed"]);
    expect(kase.edges.map((e) => e.reason).sort()).toEqual(["sameKey", "thread"]);
    expect(lab.case("nope")).toBeNull();
  });

  it("says which cases wait on someone, and lists only streams with one when asked", () => {
    graph.upsertThread({ id: "1700000009.000100", channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    graph.insertEvent({ threadId: "1700000009.000100", messageId: "1700000009.000100", agentId: "U0ATLAS", status: "blocked_on_human",
      confidence: 0.9, rawText: "OPS-202: need approval to roll back", timestamp: new Date(Date.UTC(2026, 9, 19, 10, 0)).toISOString(),
      targetedAtOperator: false });
    const lab = new GroupingLab(db.db);
    expect(lab.streams().streams.find((s) => s.key === "project:OPS")!.waiting).toBe(1);
    expect(lab.streams(undefined, 200, "waiting").streams.map((s) => s.key)).toEqual(["project:OPS"]);
    // Blocked, but not put in front of the operator: waiting on someone, not on them
    expect(lab.streams(undefined, 200, "needsYou").streams).toEqual([]);
    const statuses = lab.stream("project:OPS")!.cases.map((c) => [c.keys[0], c.status, c.waiting]).sort();
    expect(statuses).toEqual([["ticket:OPS-101", "in_progress", false], ["ticket:OPS-202", "blocked_on_human", true]]);
  });

  it("says which waiting cases are in front of the operator", () => {
    graph.upsertThread({ id: "1700000010.000100", channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    graph.insertEvent({ threadId: "1700000010.000100", messageId: "1700000010.000100", agentId: "U0ATLAS", status: "needs_decision",
      confidence: 0.9, rawText: "OPS-303: Dana, which schema do we keep?", timestamp: new Date(Date.UTC(2026, 9, 19, 11, 0)).toISOString(),
      targetedAtOperator: true });
    const lab = new GroupingLab(db.db);
    expect(lab.streams(undefined, 200, "needsYou").streams.map((s) => [s.key, s.needsYou])).toEqual([["project:OPS", 1]]);
  });

  it("connects a case to the cases about the keys its messages mention", () => {
    graph.upsertThread({ id: "1700000011.000100", channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    graph.insertEvent({ threadId: "1700000011.000100", messageId: "1700000011.000100", agentId: "U0ATLAS", status: "blocked_on_human",
      confidence: 0.9, rawText: "OPS-404: blocked by OPS-101", timestamp: new Date(Date.UTC(2026, 9, 19, 12, 0)).toISOString() });
    const lab = new GroupingLab(db.db);
    const blocked = lab.stream("project:OPS")!.cases.find((c) => c.keys.includes("ticket:OPS-404"))!;
    const connections = lab.case(blocked.id)!.connections;
    expect(connections.map((c) => [c.key, c.cases.length])).toEqual([["ticket:OPS-101", 1]]);
  });
});

describe("lab routes", () => {
  const state = (db: Database) => ({
    config: { server: { port: 9847, host: "127.0.0.1" }, operator: { name: "", role: "", context: "" }, taskAdapter: {} },
    db, graph: new ContextGraph(db), classifier: { getBackoffState: vi.fn().mockReturnValue(null) }, usageTracker: null,
    pipeline: null, messagingAdapter: null, taskAdapter: null, rateLimiters: {}, startedAt: new Date(), lastPoll: null,
    processed: 0, operatorIdentities: new Map(),
  }) as any;

  afterEach(() => vi.unstubAllEnvs());

  it("exist only with WORKSTREAM_LAB=true, and the status says so", async () => {
    const db = new Database(":memory:");
    vi.stubEnv("WORKSTREAM_LAB", "");
    const off = createApp(state(db));
    expect((await off.request("/api/lab/streams")).status).toBe(404);
    expect((await (await off.request("/api/status")).json()).lab).toBe(false);
    vi.stubEnv("WORKSTREAM_LAB", "true");
    const on = createApp(state(db));
    expect((await on.request("/api/lab/streams")).status).toBe(200);
    expect((await (await on.request("/api/status")).json()).lab).toBe(true);
    db.close();
  });
});
