// tests/grouping/split.test.ts — over-merges found as weak bridges in a case's graph

import { describe, it, expect } from "vitest";
import { applySplits, proposeSplits } from "../../core/grouping/split.js";
import type { Placement } from "../../core/grouping/cluster.js";

function p(cluster: string, about: string | null, via: string | null, reason: string): Placement {
  return { cluster, via, reasons: [reason], recognized: { kind: "work", about, aboutBy: about ? "key" : null, mentions: [], lane: null, asks: false } };
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
});
