// tests/grouping/shadow.test.ts — the v2 grouping in shadow mode: tables written, constraints applied, nothing else

import { describe, it, expect } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { runShadowGrouping, stableCaseId } from "../../core/grouping/shadow.js";
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
