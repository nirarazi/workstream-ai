// tests/grouping/split.test.ts — over-merges found as weak bridges in a case's graph

import { describe, it, expect } from "vitest";
import { applySplits, proposeSplits } from "../../core/grouping/split.js";
import { groupMessages } from "../../core/grouping/index.js";
import type { Placement } from "../../core/grouping/cluster.js";

function p(cluster: string, about: string | null, via: string | null, reason: string): Placement {
  const viaReason = via ? reason.split(/[ ,:]/)[0] : null;
  return { cluster, via, viaReason, reasons: [reason], recognized: { kind: "work", about, aboutBy: about ? "key" : null, mentions: [], lane: null, asks: false } };
}

describe("proposeSplits", () => {
  it("cuts a weak edge joining two parts about different keys, and nothing strong", () => {
    const placed = new Map<string, Placement>([
      ["a1", p("c1", "ticket:OPS-1", null, "new")],
      ["a2", p("c1", "ticket:OPS-1", "a1", "sameKey ticket:OPS-1 +10")],
      ["b1", p("c1", "ticket:OPS-2", "a2", "exchange +3")],
      ["b2", p("c1", null, "b1", "thread +6")],
    ]);
    const splits = proposeSplits(placed);
    expect(splits).toEqual([{ cluster: "c1", at: "b1", via: "a2", moved: ["b1", "b2"] }]);
    const applied = applySplits(placed, splits);
    expect(applied.get("b2")!.cluster).toBe(applied.get("b1")!.cluster);
    expect(applied.get("b1")!.cluster).not.toBe(applied.get("a1")!.cluster);
    expect(applied.get("b1")!.via).toBeNull();
  });

  it("leaves a case whose parts share a key, or are joined by a thread, as it is", () => {
    const shared = new Map<string, Placement>([
      ["a1", p("c1", "ticket:OPS-1", null, "new")],
      ["a2", p("c1", null, "a1", "thread +6")],
      ["b1", p("c1", "ticket:OPS-1", "a2", "exchange +3")],
      ["b2", p("c1", null, "b1", "thread +6")],
    ]);
    expect(proposeSplits(shared)).toEqual([]);
    const threaded = new Map<string, Placement>([
      ["a1", p("c1", "ticket:OPS-1", null, "new")],
      ["a2", p("c1", null, "a1", "thread +6")],
      ["b1", p("c1", "ticket:OPS-2", "a2", "thread +6")],
      ["b2", p("c1", null, "b1", "thread +6")],
    ]);
    expect(proposeSplits(threaded)).toEqual([]);
  });

  it("never cuts the operator's must-link, even when a weaker reason is listed first", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 9, min)).toISOString();
    const m = (key: string, threadId: string, senderId: string, senderKind: "human" | "agent", min: number, text: string) =>
      ({ key, threadId, channelId: "C0OPS", senderId, senderKind, at: at(min), text, status: "in_progress" as const, digest: false, topLevel: key === threadId });
    const messages = [
      m("a1", "a1", "U0DANA", "human", 0, "OPS-1: export started for the quarter"),
      m("a2", "a1", "U0DANA", "human", 5, "OPS-1: halfway through the export"),
      m("x1", "x1", "U0DANA", "human", 8, "checking the logs on the box now"),
      m("y1", "x1", "U0RELAY", "agent", 9, "PAY-7: the billing retry fails on the box"),
      m("y2", "x1", "U0RELAY", "agent", 10, "PAY-7: patched the retry, deploying"),
    ];
    const placed = groupMessages(messages, {
      extractTickets: (t) => [...t.matchAll(/\b([A-Z]{2,6}-\d+)\b/g)].map((x) => x[1]),
      constraints: [{ kind: "must_link", a: "x1", b: "a1" }],
    });
    expect(placed.get("x1")!.viaReason).toBe("operator");
    expect(placed.get("x1")!.cluster).toBe(placed.get("a1")!.cluster);
  });

  it("stays fast on a long chain of weak edges", () => {
    const chain = new Map<string, Placement>([["m0", p("c1", "ticket:OPS-1", null, "new")]]);
    for (let i = 1; i < 2000; i++) chain.set(`m${i}`, p("c1", i === 1999 ? "ticket:OPS-2" : null, `m${i - 1}`, "continuation +3"));
    const started = performance.now();
    proposeSplits(chain);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
