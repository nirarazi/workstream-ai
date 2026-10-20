// tests/eval/inbox-diff.test.ts — Needs me by case under v2, and how it lines up with the live items

import { describe, it, expect } from "vitest";
import { compareInboxes, v2Inbox, type Escalation, type EventInfo, type ItemState } from "../../core/eval/inbox-diff.js";
import type { LoadedMessage } from "../../core/grouping/load.js";
import type { Case } from "../../core/grouping/streams.js";
import type { ActionableItem } from "../../core/types.js";

let n = 0;
function msg(over: Partial<LoadedMessage> = {}): LoadedMessage {
  n++;
  return {
    key: `slack:C0OPS:${n}`, eventId: `e${n}`, threadId: "T1", channelId: "C0OPS", channelName: "ops", senderId: "U0ATLAS",
    senderName: "Atlas", senderKind: "agent", at: new Date(Date.UTC(2026, 9, 19, 9, n)).toISOString(), text: `message ${n}`,
    status: "in_progress", digest: false, topLevel: false, targetedAtOperator: false, actionRequiredFrom: null, ...over,
  };
}
const asCase = (id: string, ms: LoadedMessage[]): Case =>
  ({ id, keys: [], stream: "channel:C0OPS", first: ms[0].at, last: ms[ms.length - 1].at, members: ms.map((m) => ({ key: m.key, at: m.at, via: null, viaReason: null, reasons: [] })) });
const ask = (over: Partial<LoadedMessage> = {}) => msg({ status: "blocked_on_human", targetedAtOperator: true, ...over });
const OPTS = { operatorNames: ["Dana"], handoff: 0.6, now: "2026-10-20T00:00:00.000Z" };
const state = (over: Partial<ItemState> = {}): ItemState => ({ status: "blocked_on_human", snoozedUntil: null, dismissedAt: null, mergedInto: null, closedByOperator: null, ...over });

function inbox(cases: Array<[string, LoadedMessage[]]>, extra: { items?: Map<string, ItemState>; events?: Map<string, EventInfo>; escalations?: Map<string, Escalation[]> } = {}) {
  const all = cases.flatMap(([, ms]) => ms);
  return v2Inbox(cases.map(([id, ms]) => asCase(id, ms)), new Map(all.map((m) => [m.key, m])), extra.events ?? new Map(),
    extra.items ?? new Map(), extra.escalations ?? new Map(), OPTS);
}

describe("v2Inbox", () => {
  it("surfaces a case whose latest ask is aimed at the operator, until something moves it on", () => {
    const waiting = [msg(), ask()];
    const movedOn = [ask(), msg({ status: "completed" })];
    const noiseAfter = [ask(), msg({ status: "noise" })];
    const v2 = inbox([["c1", waiting], ["c2", movedOn], ["c3", noiseAfter]]);
    expect(v2.entries.map((e) => e.caseId)).toEqual(["c1", "c3"]);
  });

  it("never counts the operator's own message as an ask of them, and holds a case handed to someone else", () => {
    const own = [ask({ senderId: "U0DANA", senderName: "Dana" })];
    const handed = [ask(), msg({ status: "blocked_on_human", targetedAtOperator: false, actionRequiredFrom: ["Alex Rivera"] })];
    const stillTheirs = [ask(), msg({ status: "blocked_on_human", targetedAtOperator: false, actionRequiredFrom: ["Dana"] })];
    const events = new Map<string, EventInfo>([...handed, ...stillTheirs].map((m) => [m.eventId, { confidence: 0.9, workItemId: null }]));
    const v2 = inbox([["own", own], ["handed", handed], ["theirs", stillTheirs]], { events });
    expect(v2.entries.map((e) => e.caseId)).toEqual(["theirs"]);
    expect(v2.held.get("handed")).toBe("handed off");
  });

  it("honours the operator's snooze, dismissal and closing of the item the ask was filed under", () => {
    const [a, b, c, d] = [ask(), ask(), ask(), ask()];
    const events = new Map<string, EventInfo>([[a.eventId, { confidence: 1, workItemId: "OPS-1" }], [b.eventId, { confidence: 1, workItemId: "OPS-2" }],
      [c.eventId, { confidence: 1, workItemId: "OPS-3" }], [d.eventId, { confidence: 1, workItemId: "OPS-4" }]]);
    const items = new Map([
      ["OPS-1", state({ snoozedUntil: "2026-10-21T00:00:00.000Z" })],
      ["OPS-2", state({ dismissedAt: "2026-10-19T12:00:00.000Z" })],
      ["OPS-3", state({ closedByOperator: { status: "completed", at: "2026-10-19T12:00:00.000Z" } })],
      // Dismissed before the ask: the ask is news since
      ["OPS-4", state({ dismissedAt: "2026-10-01T00:00:00.000Z" })],
    ]);
    const v2 = inbox([["a", [a]], ["b", [b]], ["c", [c]], ["d", [d]]], { events, items });
    expect(v2.entries.map((e) => e.caseId)).toEqual(["d"]);
    expect([...v2.held.values()]).toEqual(["snoozed", "dismissed", "closed by the operator"]);
  });

  it("takes a report's escalated line as an ask on its case, or as an entry of its own for an item no case holds", () => {
    const member = msg();
    // After the case's own message: an ask since it
    const report = msg({ status: "blocked_on_human", targetedAtOperator: false });
    const escalations = new Map<string, Escalation[]>([
      ["c1", [{ message: report, itemId: "OPS-1" }]],
      ["item:OPS-9", [{ message: report, itemId: "OPS-9" }]],
      ["item:OPS-8", [{ message: report, itemId: "OPS-8" }]],
    ]);
    const items = new Map([["OPS-1", state()], ["OPS-9", state()], ["OPS-8", state({ status: "in_progress" })]]);
    const v2 = inbox([["c1", [member]]], { escalations, items });
    expect(v2.entries.map((e) => [e.caseId, e.itemId, e.fromReport])).toEqual([["c1", "OPS-1", true], ["item:OPS-9", "OPS-9", true]]);
  });
});

describe("compareInboxes", () => {
  const live = (id: string, eventId: string) => ({ workItem: { id }, latestEvent: { id: eventId } }) as unknown as ActionableItem;

  it("lines up items with cases by where their message landed, and lists what only one side shows", () => {
    const v2 = { entries: [
      { caseId: "c1", ask: msg(), itemId: "OPS-1", fromReport: false },
      { caseId: "c2", ask: msg(), itemId: "OPS-7", fromReport: false },
      { caseId: "c3", ask: msg(), itemId: "OPS-5", fromReport: true },
    ], held: new Map() };
    const keys = new Map([["e1", "k1"], ["e2", "k2"], ["e3", "k3"], ["e5", "k5"]]);
    const cases = new Map([["k1", "c1"], ["k2", "c1"], ["k3", "c9"]]);
    const cmp = compareInboxes(
      [live("OPS-1", "e1"), live("OPS-2", "e2"), live("OPS-3", "e3"), live("OPS-5", "e5")], v2,
      (id) => keys.get(id), (k) => cases.get(k) ?? null, () => "moved on", () => "item done",
    );
    expect(cmp.both.map((b) => [b.item.workItem.id, b.caseId])).toEqual([["OPS-1", "c1"], ["OPS-2", "c1"], ["OPS-5", "c3"]]);
    expect(cmp.liveOnly.map((x) => x.item.workItem.id)).toEqual(["OPS-3"]);
    expect(cmp.v2Only.map((x) => x.entry.caseId)).toEqual(["c2"]);
    expect(cmp.merged.map((x) => [x.caseId, x.items.length])).toEqual([["c1", 2]]);
  });
});
