// tests/grouping/shadow.test.ts — the v2 grouping in shadow mode: tables written, constraints applied, nothing else

import { describe, it, expect } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { groupingVersion, runShadowGrouping, stableCaseId } from "../../core/grouping/shadow.js";
import { observeSlackMessage } from "../../core/adapters/messaging/slack/observe.js";
import type { Message } from "../../core/types.js";

function setup() {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  graph.upsertAgent({ id: "U0ATLAS", name: "Atlas", platform: "slack", platformUserId: "U0ATLAS", isBot: true });
  const say = (ts: string, text: string, minute: number, status: "in_progress" | "blocked_on_human" = "in_progress") => {
    graph.upsertThread({ id: ts, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    const timestamp = new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString();
    graph.recordObservation(observeSlackMessage({ id: ts, threadId: ts, channelId: "C0OPS", channelName: "ops", userId: "U0ATLAS",
      userName: "Atlas", text, timestamp, platform: "slack", senderType: "agent" } as Message, { teamId: "T0NORTHWND", url: null })!);
    graph.insertEvent({ threadId: ts, messageId: ts, agentId: "U0ATLAS", status, confidence: 0.9, rawText: text, timestamp });
  };
  return { db, graph, say };
}

describe("runShadowGrouping", () => {
  it("writes cases and assignments with stable ids, and skips a run when nothing was added", () => {
    const { db, say } = setup();
    say("1700000001.000100", "OPS-101: started the export", 0);
    say("1700000002.000100", "OPS-101: blocked on the schema change", 30, "blocked_on_human");
    const first = runShadowGrouping(db.db, null);
    expect(first.run).toMatchObject({ messages: 2, cases: 1 });
    const kase = db.db.prepare("SELECT * FROM v2_cases").get() as { id: string; stream: string; status: string; waiting: number; size: number };
    expect(kase).toMatchObject({ id: stableCaseId("slack:C0OPS:1700000001.000100"), stream: "project:OPS", status: "blocked_on_human", waiting: 1, size: 2 });
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM v2_assignments").get() as { n: number }).n).toBe(2);
    expect(runShadowGrouping(db.db, first.version).run).toBeNull();
    // What each message says, as edges: its kind, and the key it's about
    const claims = db.db.prepare("SELECT claim, value, relation FROM v2_claims WHERE message_key = ? ORDER BY claim").all("slack:C0OPS:1700000001.000100");
    expect(claims).toEqual([{ claim: "about", value: "ticket:OPS-101", relation: "key" }, { claim: "kind", value: "work", relation: null }]);
    db.close();
  });

  it("applies the operator's constraints, mapped from the observations they name", () => {
    const { db, graph, say } = setup();
    say("1700000001.000100", "OPS-101: started the export", 0);
    say("1700000002.000100", "OPS-101: halfway", 5);
    graph.constraints.add({ kind: "cannot_link", a: "slack:T0NORTHWND/C0OPS/1700000001.000100", b: "slack:T0NORTHWND/C0OPS/1700000002.000100", decidedBy: "operator" });
    runShadowGrouping(db.db, null);
    const cases = db.db.prepare("SELECT case_id FROM v2_assignments ORDER BY message_key").all() as Array<{ case_id: string }>;
    expect(cases[0].case_id).not.toBe(cases[1].case_id);
    db.close();
  });
});

describe("groupingVersion", () => {
  it("changes when an agent is renamed or reclassified, and when a constraint is added", () => {
    const db = new Database(":memory:");
    try {
      const graph = new ContextGraph(db);
      const now = new Date().toISOString();
      db.db.prepare("INSERT INTO agents (id, name, platform, platform_user_id, first_seen, last_seen) VALUES (?, ?, 'slack', ?, ?, ?)")
        .run("U0RELAY", "Relay", "U0RELAY", now, now);
      const versions = [groupingVersion(db.db)];
      db.db.prepare("UPDATE agents SET name = 'Relay - Builder' WHERE id = 'U0RELAY'").run();
      versions.push(groupingVersion(db.db));
      db.db.prepare("UPDATE agents SET bot_type = 'notification' WHERE id = 'U0RELAY'").run();
      versions.push(groupingVersion(db.db));
      graph.constraints.add({ kind: "not_an_item", a: "slack:T0NORTHWND/C0OPS/1700000001.000100", decidedBy: "operator" });
      versions.push(groupingVersion(db.db));
      versions.push(groupingVersion(db.db));
      expect(new Set(versions).size).toBe(4);
      expect(versions[4]).toBe(versions[3]);
    } finally {
      db.close();
    }
  });
});
