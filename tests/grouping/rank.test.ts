// tests/grouping/rank.test.ts — What's blocked on the operator, ranked by who it holds up, how often asked, how long

import { describe, it, expect } from "vitest";
import type { Ask } from "../../core/grouping/asks.js";
import type { V2Entry } from "../../core/grouping/inbox.js";
import type { LoadedMessage } from "../../core/grouping/load.js";
import { ago, rankNeedsYou, rankReason } from "../../core/grouping/rank.js";
import type { Case } from "../../core/grouping/streams.js";

let n = 0;
function msg(over: Partial<LoadedMessage> = {}): LoadedMessage {
  n++;
  return {
    key: `slack:C0OPS:${n}`, eventId: `e${n}`, threadId: "T1", channelId: "C0OPS", channelName: "ops", senderId: "U0ATLAS",
    senderName: "Atlas", senderKind: "agent", at: new Date(Date.UTC(2026, 9, 19, 9, n)).toISOString(), text: `message ${n}`,
    status: "in_progress", digest: false, topLevel: false, targetedAtOperator: false, actionRequiredFrom: null, ...over,
  };
}
const ask = (over: Partial<LoadedMessage> = {}) => msg({ status: "blocked_on_human", targetedAtOperator: true, ...over });
const asCase = (id: string, ms: LoadedMessage[]): Case =>
  ({ id, keys: [], stream: "channel:C0OPS", first: ms[0].at, last: ms[ms.length - 1].at, members: ms.map((m) => ({ key: m.key, at: m.at, via: null, viaReason: null, reasons: [] })) });
const block = (caseId: string, from: string, to: string, at = "2026-10-19T09:00:00.000Z", answeredAt: string | null = null): Ask =>
  ({ strength: "blocks", message: `m-${from}-${to}`, caseId, from, to, at, answeredAt, answeredBy: null });
const OPTS = { operatorNames: ["Dana"], operatorActors: new Set(["U0DANA"]), since: "2026-10-10T00:00:00.000Z" };

function rank(cases: Array<[string, LoadedMessage[]]>, asks: Ask[] = []) {
  const all = cases.flatMap(([, ms]) => ms);
  const entries: V2Entry[] = cases.map(([id, ms]) => ({ caseId: id, ask: ms[ms.length - 1], itemId: null, fromReport: false }));
  return rankNeedsYou(entries, new Map(cases.map(([id, ms]) => [id, asCase(id, ms)])), new Map(all.map((m) => [m.key, m])), asks, OPTS);
}

describe("rankNeedsYou", () => {
  it("puts an ask with a queue behind it first, then the one asked most, then the one waiting longest", () => {
    const old = [ask({ senderId: "U0OLD", at: "2026-10-12T00:00:00.000Z" })];
    const twice = [ask({ senderId: "U0RELAY" }), ask({ senderId: "U0RELAY" })];
    const queued = [ask({ senderId: "U0ATLAS" })];
    const ranked = rank([["old", old], ["twice", twice], ["queued", queued]], [block("queued", "U0RELAY", "U0ATLAS")]);
    expect(ranked.map((r) => r.entry.caseId)).toEqual(["queued", "twice", "old"]);
    expect(ranked[0].heldUp).toEqual(["U0ATLAS", "U0RELAY"]);
    expect(ranked[1].timesAsked).toBe(2);
  });

  it("counts only who is blocked in the same case, and not answered or stale blocks", () => {
    const c1 = [ask({ senderId: "U0ATLAS" })];
    const ranked = rank([["c1", c1]], [
      block("other", "U0RELAY", "U0ATLAS"),
      block("c1", "U0NOVA", "U0ATLAS", "2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"),
      block("c1", "U0OLD", "U0ATLAS", "2026-09-01T00:00:00.000Z"),
    ]);
    expect(ranked[0].heldUp).toEqual(["U0ATLAS"]);
  });

  it("stops counting asks at the operator's own message or one that moved the case on", () => {
    const c1 = [ask(), msg({ senderName: "Dana", senderId: "U0DANA", status: "in_progress" }), ask(), msg({ status: "noise" }), ask()];
    expect(rank([["c1", c1]])[0].timesAsked).toBe(2);
  });

  it("holds no one up with an ask older than the window", () => {
    const c1 = [ask({ senderId: "U0ATLAS", at: "2026-09-01T00:00:00.000Z" })];
    expect(rank([["c1", c1]])[0].heldUp).toEqual([]);
  });
});

describe("rankReason", () => {
  it("says why in a sentence", () => {
    const r = rank([["c1", [ask({ senderId: "U0ATLAS", at: "2026-10-18T00:00:00.000Z" }), ask({ senderId: "U0ATLAS", at: "2026-10-18T01:00:00.000Z" })]]],
      [block("c1", "U0RELAY", "U0ATLAS"), block("c1", "U0NOVA", "U0ATLAS"), block("c1", "U0KAI", "U0ATLAS")])[0];
    const names: Record<string, string> = { U0ATLAS: "Atlas", U0RELAY: "Relay", U0NOVA: "Nova", U0KAI: "Kai" };
    expect(rankReason(r, "2026-10-21T00:00:00.000Z", (id) => names[id])).toBe("holds up Atlas, Kai and 2 more · asked 2 times · waiting 3 days");
  });

  it("joins up to three names with 'and'", () => {
    const r = rank([["c1", [ask({ senderId: "U0ATLAS" })]]], [block("c1", "U0RELAY", "U0ATLAS")])[0];
    expect(rankReason(r, "2026-10-19T12:00:00.000Z", (id) => (id === "U0ATLAS" ? "Atlas" : "Relay"))).toMatch(/^holds up Atlas and Relay · waiting \d+ hours$/);
  });
});

describe("ago", () => {
  it("reads as hours, then days", () => {
    expect(ago("2026-10-20T00:00:00.000Z", "2026-10-20T00:30:00.000Z")).toBe("under an hour");
    expect(ago("2026-10-20T00:00:00.000Z", "2026-10-20T05:00:00.000Z")).toBe("5 hours");
    expect(ago("2026-10-20T00:00:00.000Z", "2026-10-23T01:00:00.000Z")).toBe("3 days");
  });
});
