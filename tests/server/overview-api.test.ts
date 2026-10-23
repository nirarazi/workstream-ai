// tests/server/overview-api.test.ts — GET /api/overview: read only, from the grouping shadow mode stored

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { runShadowGrouping } from "../../core/grouping/shadow.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database) {
  return {
    config: { server: { port: 9847, host: "127.0.0.1" }, operator: { name: "Dana" } },
    db,
    graph,
    classifier: { classify: vi.fn() },
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    operatorIdentities: new Map(),
    startedAt: new Date(),
  } as any;
}

describe("GET /api/overview", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U0ATLAS", name: "Atlas", platform: "slack", platformUserId: "U0ATLAS", isBot: true });
  });
  afterEach(() => db.close());

  function say(ts: string, text: string, hoursAgo: number, status: "in_progress" | "blocked_on_human" = "in_progress") {
    graph.upsertThread({ id: ts, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    graph.insertEvent({ threadId: ts, messageId: ts, agentId: "U0ATLAS", status, confidence: 0.9, rawText: text,
      timestamp: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() });
  }

  it("is empty before shadow mode stores a grouping, and never regroups itself", async () => {
    say("1700000001.000100", "OPS-101: blocked on the schema change", 2, "blocked_on_human");
    const res = await createApp(makeState(graph, db)).request("/api/overview");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupedAt: null, needsYou: { total: 0 } });
    expect(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'v2_cases'").get()).toBeUndefined();
  });

  it("shows what needs the operator, and reads 'since' as the last day when it's missing or in the future", async () => {
    say("1700000001.000100", "OPS-101: started the export", 3);
    say("1700000002.000100", "OPS-101: blocked on the schema change", 2, "blocked_on_human");
    runShadowGrouping(db.db, null);
    const app = createApp(makeState(graph, db));
    const body = await (await app.request(`/api/overview?since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`)).json();
    expect(body.needsYou.rows.map((r: { title: string }) => r.title)).toEqual(["OPS-101: blocked on the schema change"]);
    expect(Date.parse(body.now) - Date.parse(body.since)).toBeGreaterThan(23 * 3_600_000);
    expect(body.changes.new).toBe(1);
    const area = await (await app.request("/api/overview?area=channel%3AC0ELSE")).json();
    expect(area).toMatchObject({ area: "channel:C0ELSE", needsYou: { total: 0 } });
  });
});
