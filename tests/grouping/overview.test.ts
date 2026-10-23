// tests/grouping/overview.test.ts — The Overview: pace, stuck and noisy streams, finished work, areas, lenses, changes

import { describe, it, expect } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import type { LoadedMessage } from "../../core/grouping/load.js";
import { buildOverview, loadOverviewInput, movementsOf, stuckLineMs, type OverviewInput } from "../../core/grouping/overview.js";
import type { V2Entry } from "../../core/grouping/inbox.js";
import { computeGrouping, runShadowGrouping } from "../../core/grouping/shadow.js";
import { loadStoredGrouping } from "../../core/grouping/stored.js";
import type { Case, Stream } from "../../core/grouping/streams.js";

const DAY = 86_400_000;
const NOW = "2026-10-20T12:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * DAY).toISOString();

let n = 0;
function msg(at: string, over: Partial<LoadedMessage> = {}): LoadedMessage {
  n++;
  return {
    key: `slack:C0OPS:${n}`, eventId: `e${n}`, threadId: "T1", channelId: "C0OPS", channelName: "ops", senderId: "U0ATLAS",
    senderName: "Atlas", senderKind: "agent", at, text: `message ${n}`, status: "in_progress", digest: false, topLevel: false,
    targetedAtOperator: false, actionRequiredFrom: null, ...over,
  };
}
const asCase = (id: string, stream: string, ms: LoadedMessage[]): Case =>
  ({ id, keys: [], stream, first: ms[0].at, last: ms[ms.length - 1].at, members: ms.map((m) => ({ key: m.key, at: m.at, via: null, viaReason: null, reasons: [] })) });

function input(cases: Array<[string, string, LoadedMessage[]]>, extra: { kinds?: Map<string, string>; direct?: string[]; needsYou?: V2Entry[]; held?: string[] } = {}): OverviewInput {
  const all = cases.flatMap(([, , ms]) => ms);
  const cs = cases.map(([id, stream, ms]) => asCase(id, stream, ms));
  const streams = new Map<string, Stream>();
  for (const c of cs) {
    const s = streams.get(c.stream) ?? { key: c.stream, cases: [], messages: 0, last: "" };
    s.cases.push(c.id);
    s.messages += c.members.length;
    if (c.last > s.last) s.last = c.last;
    streams.set(c.stream, s);
  }
  const needsYou = extra.needsYou ?? [];
  return {
    grouping: { messages: all, cases: cs, streams: [...streams.values()], kinds: extra.kinds ?? new Map(), directChannels: new Set(extra.direct ?? []), computedAt: NOW },
    needsYou,
    held: new Set(extra.held ?? []),
    ranked: needsYou.map((entry) => ({ entry, heldUp: [], timesAsked: 1, waitingSince: entry.ask.at })),
    actorName: (id) => id,
  };
}
const lens = (over: { since?: string; area?: string | null } = {}) => ({ now: NOW, since: over.since ?? daysAgo(1), area: over.area ?? null });

describe("movementsOf", () => {
  it("counts status changes in work, never reports, telemetry or noise", () => {
    const ms = [msg(daysAgo(5)), msg(daysAgo(4)), msg(daysAgo(3), { status: "blocked_on_human" }), msg(daysAgo(2), { status: "completed" }), msg(daysAgo(1), { status: "noise" })];
    const kinds = new Map([[ms[3].key, "report"]]);
    const { at, status } = movementsOf(asCase("c", "s", ms), new Map(ms.map((m) => [m.key, m])), kinds);
    expect(at).toEqual([ms[0].at, ms[2].at]);
    expect(status).toBe("blocked_on_human");
  });
});

describe("stuckLineMs", () => {
  it("is seven days for a new stream, else three median gaps and at least two days", () => {
    expect(stuckLineMs([daysAgo(3), daysAgo(1)])).toBe(7 * DAY);
    expect(stuckLineMs([daysAgo(30), daysAgo(20), daysAgo(10)])).toBe(30 * DAY);
    expect(stuckLineMs([daysAgo(1), daysAgo(1), daysAgo(1)])).toBe(2 * DAY);
  });
});

describe("buildOverview", () => {
  it("calls a stream stuck only when a case in it waits on someone past its pace, not when it's quiet", () => {
    const waiting = [msg(daysAgo(9)), msg(daysAgo(8), { status: "blocked_on_human" })];
    const quiet = [msg(daysAgo(9))];
    const recent = [msg(daysAgo(3)), msg(daysAgo(2), { status: "needs_decision" })];
    const o = buildOverview(input([["c1", "subject:northwind", waiting], ["c2", "subject:contoso", quiet], ["c3", "project:OPS", recent]]), lens());
    expect(o.stuck.rows.map((r) => r.stream)).toEqual(["subject:northwind"]);
    expect(o.stuck.rows[0]).toMatchObject({ why: ["stuck"], detail: "no movement for 8 days", title: waiting[0].text });
    expect(o.movingNormally).toBe(2);
  });

  it("leaves a case already in front of the operator to needs you, not stuck", () => {
    const waiting = [msg(daysAgo(9)), msg(daysAgo(8), { status: "blocked_on_human", targetedAtOperator: true })];
    const o = buildOverview(input([["c1", "subject:northwind", waiting]], { needsYou: [{ caseId: "c1", ask: waiting[1], itemId: null, fromReport: false }] }), lens());
    expect(o.stuck.total).toBe(0);
    expect(o.needsYou.rows).toMatchObject([{ caseId: "c1", streamLabel: "northwind", detail: "waiting 8 days" }]);
    expect(o.movingNormally).toBe(0);
  });

  it("leaves a case the operator already dealt with (snoozed, acted on) or that was handed on out of stuck", () => {
    const waiting = [msg(daysAgo(9)), msg(daysAgo(8), { status: "blocked_on_human" })];
    const o = buildOverview(input([["c1", "subject:northwind", waiting]], { held: ["c1"] }), lens());
    expect(o.stuck.total).toBe(0);
    expect(o.movingNormally).toBe(1);
  });

  it("counts what finished since a look longer ago than the seven days it lists", () => {
    const done = [msg(daysAgo(12)), msg(daysAgo(10), { status: "completed" })];
    const o = buildOverview(input([["c1", "subject:northwind", done]]), lens({ since: daysAgo(14) }));
    expect(o.finished.total).toBe(0);
    expect(o.changes.finished).toBe(1);
  });

  it("calls a busy stream with no movement this week noisy, counting neither reports nor noise", () => {
    const busy = [msg(daysAgo(10)), ...Array.from({ length: 10 }, (_, i) => msg(daysAgo(6 - i * 0.5)))];
    const reports = [msg(daysAgo(10)), ...Array.from({ length: 12 }, (_, i) => msg(daysAgo(6 - i * 0.4)))];
    const kinds = new Map(reports.slice(1).map((m) => [m.key, "report"]));
    const o = buildOverview(input([["c1", "channel:C0OPS", busy], ["c2", "jobs", reports]], { kinds }), lens());
    expect(o.stuck.rows.map((r) => [r.stream, r.why])).toEqual([["channel:C0OPS", ["noisy"]]]);
    expect(o.stuck.rows[0].streamLabel).toBe("#ops");
  });

  it("lists what finished in the last seven days, and counts what changed since the last look", () => {
    const done = [msg(daysAgo(3)), msg(daysAgo(0.5), { status: "completed" })];
    const doneLong = [msg(daysAgo(20)), msg(daysAgo(10), { status: "completed" })];
    const fresh = [msg(daysAgo(0.2))];
    const o = buildOverview(input([["c1", "subject:northwind", done], ["c2", "subject:contoso", doneLong], ["c3", "project:OPS", fresh]]), lens());
    expect(o.finished.rows.map((r) => r.caseId)).toEqual(["c1"]);
    expect(o.changes).toMatchObject({ finished: 1, new: 1 });
    expect(buildOverview(input([["c1", "subject:northwind", done]]), lens({ since: daysAgo(0.1) })).changes.finished).toBe(0);
  });

  it("puts each stream in the area most of its messages are in, direct messages together, and filters by lens", () => {
    const inOps = [msg(daysAgo(9)), msg(daysAgo(8), { status: "blocked_on_human" })];
    const mostlyDm = [msg(daysAgo(2), { channelId: "D0DANA", channelName: "DM: Dana" }), msg(daysAgo(1), { channelId: "D0DANA", channelName: "DM: Dana" }), msg(daysAgo(1))];
    const o = buildOverview(input([["c1", "subject:northwind", inOps], ["c2", "subject:contoso", mostlyDm]], { direct: ["D0DANA"] }), lens());
    expect(o.areas).toEqual([
      { id: "channel:C0OPS", label: "#ops", active: 1, off: 1 },
      { id: "direct", label: "Direct messages", active: 1, off: 0 },
    ]);
    const direct = buildOverview(input([["c1", "subject:northwind", inOps], ["c2", "subject:contoso", mostlyDm]], { direct: ["D0DANA"] }), lens({ area: "direct" }));
    expect(direct.stuck.total).toBe(0);
    expect(direct.movingNormally).toBe(1);
  });

  it("leaves out streams with no message in 30 days", () => {
    const o = buildOverview(input([["c1", "subject:northwind", [msg(daysAgo(40)), msg(daysAgo(39), { status: "blocked_on_human" })]]]), lens());
    expect(o.stuck.total + o.movingNormally + o.areas.length).toBe(0);
  });
});

describe("loadOverviewInput", () => {
  it("reads the grouping shadow mode stored, the same cases computeGrouping makes, and finds nothing before it runs", () => {
    const db = new Database(":memory:");
    try {
      const graph = new ContextGraph(db);
      graph.upsertAgent({ id: "U0ATLAS", name: "Atlas", platform: "slack", platformUserId: "U0ATLAS", isBot: true });
      const say = (ts: string, text: string, minute: number, status: "in_progress" | "blocked_on_human" = "in_progress") => {
        graph.upsertThread({ id: ts, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null, platformMeta: { isDirect: false } });
        graph.insertEvent({ threadId: ts, messageId: ts, agentId: "U0ATLAS", status, confidence: 0.9, rawText: text, timestamp: new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString() });
      };
      say("1700000001.000100", "OPS-101: started the export", 0);
      say("1700000002.000100", "OPS-101: blocked on the schema change", 30, "blocked_on_human");
      say("1700000003.000100", "OPS-202: deploy queued", 40);
      const opts = { operatorNames: ["Dana"], handoff: 0.6, now: NOW };
      expect(loadOverviewInput(db.db, opts)).toBeNull();
      runShadowGrouping(db.db, null);
      const stored = loadStoredGrouping(db.db)!;
      const live = computeGrouping(db.db);
      const shape = (cs: Case[]) => cs.map((c) => ({ id: c.id, stream: c.stream, keys: c.keys, members: c.members.map((m) => m.key) })).sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(shape(stored.cases)).toEqual(shape(live.cases));
      expect(stored.kinds.get("slack:C0OPS:1700000001.000100")).toBe("work");
      expect(loadOverviewInput(db.db, opts)!.needsYou.map((e) => e.ask.text)).toEqual(["OPS-101: blocked on the schema change"]);
    } finally {
      db.close();
    }
  });

  it("knows a direct message by its thread's platform meta", () => {
    const db = new Database(":memory:");
    try {
      const graph = new ContextGraph(db);
      graph.upsertThread({ id: "t1", channelId: "D0DANA", channelName: "DM: Dana", platform: "slack", workItemId: null, platformMeta: { isPrivate: true, isDirect: true } });
      graph.upsertThread({ id: "t2", channelId: "G0PRIV", channelName: "private", platform: "slack", workItemId: null, platformMeta: { isPrivate: true, isDirect: false } });
      graph.insertEvent({ threadId: "t1", messageId: "t1", status: "in_progress", confidence: 0.9, rawText: "OPS-101 started", timestamp: NOW });
      runShadowGrouping(db.db, null);
      expect([...loadStoredGrouping(db.db)!.directChannels]).toEqual(["D0DANA"]);
    } finally {
      db.close();
    }
  });
});
