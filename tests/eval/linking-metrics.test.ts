// tests/eval/linking-metrics.test.ts — Linking eval scoring: Wilson intervals, pairwise scores, not-work rate, B-cubed

import { describe, it, expect } from "vitest";
import { bcubed, byStratum, notWorkRate, pairwiseScores, scoreGrouping, wilson, type LabeledPair } from "../../core/eval/linking-metrics.js";

const grouping = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("wilson", () => {
  it("matches the textbook interval", () => {
    const half = wilson(5, 10);
    expect(half.p).toBe(0.5);
    expect(half.lo).toBeCloseTo(0.2366, 3);
    expect(half.hi).toBeCloseTo(0.7634, 3);
  });

  it("stays inside [0, 1] at 0 and n successes, and is wide on small samples", () => {
    const none = wilson(0, 10);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeCloseTo(0.2775, 3);
    const all = wilson(3, 3);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeCloseTo(0.4385, 3);
  });

  it("is undefined with no observations", () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, lo: 0, hi: 1 });
  });
});

describe("pairwiseScores", () => {
  // Atlas's key rotation (a1, a2) is one item; Relay's Northwind export (r1) was merged into it; r2 was split off
  const g = grouping({ a1: "OPS-101", a2: "OPS-101", r1: "OPS-101", r2: "thread:t2" });
  const pairs: LabeledPair[] = [
    { a: "a1", b: "a2", verdict: "same" }, // together, same: tp
    { a: "a1", b: "r1", verdict: "different" }, // together, different: fp (over-merge)
    { a: "r1", b: "r2", verdict: "same" }, // apart, same: fn (split)
    { a: "a2", b: "r2", verdict: "different" }, // apart, different: tn
    { a: "a1", b: "x9", verdict: "same" }, // x9 is in no item: apart, so a split
  ];

  it("counts over-merges and splits, and scores precision and recall", () => {
    const s = pairwiseScores(pairs, g);
    expect({ tp: s.tp, fp: s.fp, fn: s.fn, tn: s.tn }).toEqual({ tp: 1, fp: 1, fn: 2, tn: 1 });
    expect(s.precision.p).toBe(0.5);
    expect(s.recall.p).toBeCloseTo(1 / 3);
    expect(s.f1).toBeCloseTo(0.4);
  });

  it("leaves precision undefined when the grouping puts no labeled pair together, but F1 is still 0", () => {
    const s = pairwiseScores([{ a: "a1", b: "r2", verdict: "same" }], g);
    expect(s.precision.p).toBeNull();
    expect(s.recall.p).toBe(0);
    expect(s.f1).toBe(0);
  });

  it("computes F1 as 2tp / (2tp + fp + fn), undefined only with no tp, fp or fn", () => {
    const merged = pairwiseScores([{ a: "a1", b: "r1", verdict: "different" }, { a: "a2", b: "r2", verdict: "different" }], g);
    expect(merged.recall.p).toBeNull();
    expect(merged.f1).toBe(0);
    expect(pairwiseScores([{ a: "a2", b: "r2", verdict: "different" }], g).f1).toBeNull();
  });

  it("breaks agreement down by stratum", () => {
    const strata = byStratum(pairs.map((p, i) => ({ ...p, stratum: i < 2 ? "together:current" : "shared-ref" })), g);
    expect(strata["together:current"]).toEqual({ pairs: 2, same: 1, together: 2, agree: 1 });
    expect(strata["shared-ref"]).toEqual({ pairs: 3, same: 2, together: 0, agree: 1 });
  });
});

describe("notWorkRate and scoreGrouping", () => {
  const g = grouping({ a1: "OPS-101", a2: "OPS-101", h1: "thread:t3", h2: "thread:t3" });

  it("counts not-work messages among the labeled messages the grouping places", () => {
    // h1 is a heartbeat in an item; u1 is not work and in no item, so it doesn't count against the grouping
    const r = notWorkRate(["a1", "a2", "h1", "h1", "u1"], new Set(["h1", "u1"]), g);
    expect(r.k).toBe(1);
    expect(r.n).toBe(3);
  });

  it("leaves pairs with a not-work message out of the pairwise scores", () => {
    const s = scoreGrouping({
      pairs: [
        { a: "a1", b: "a2", verdict: "same" },
        { a: "h1", b: "h2", verdict: "same" },
        { a: "a1", b: "z1", verdict: "different" },
      ],
      notWork: [{ message: "h1" }],
    }, g);
    expect(s.pairsWithNotWork).toBe(1);
    expect(s.pairwise.tp).toBe(1);
    expect(s.pairwise.tn).toBe(1);
    expect(s.notWork.k).toBe(1);
    expect(s.notWork.n).toBe(4);
    expect(s.unplaced).toBe(1);
  });

  it("leaves out labeled messages the database doesn't hold, rather than scoring them as unplaced", () => {
    const labels = {
      pairs: [
        { a: "a1", b: "a2", verdict: "same" as const },
        { a: "a1", b: "old1", verdict: "same" as const },
      ],
      notWork: [{ message: "old2" }],
    };
    const s = scoreGrouping(labels, g, new Set(["a1", "a2", "h1", "h2"]));
    expect(s.unknownMessages).toBe(2);
    expect(s.pairsWithUnknown).toBe(1);
    expect(s.pairwise.fn).toBe(0);
    expect(s.unplaced).toBe(0);
    expect(s.notWork.n).toBe(2);
    // Without the database's keys, the same pair counts as a split
    expect(scoreGrouping(labels, g).pairwise.fn).toBe(1);
  });
});

describe("bcubed", () => {
  it("is perfect for an identical clustering, whatever the item ids", () => {
    const gold = grouping({ a: "1", b: "1", c: "2" });
    expect(bcubed(gold, grouping({ a: "x", b: "x", c: "y" }))).toEqual({ precision: 1, recall: 1, f1: 1, n: 3 });
  });

  it("penalises a merge in precision and a split in recall", () => {
    const gold = grouping({ a: "1", b: "1", c: "2", d: "2" });
    const merged = bcubed(gold, grouping({ a: "x", b: "x", c: "x", d: "x" }));
    expect(merged.precision).toBe(0.5);
    expect(merged.recall).toBe(1);
    const split = bcubed(gold, grouping({ a: "x", b: "y", c: "z", d: "w" }));
    expect(split.precision).toBe(1);
    expect(split.recall).toBe(0.5);
  });

  it("counts an unplaced message as an item of its own and ignores messages outside the gold set", () => {
    const gold = grouping({ a: "1", b: "1", c: "2" });
    // c unplaced; e isn't in the gold set (and doesn't dilute x's precision)
    const s = bcubed(gold, grouping({ a: "x", b: "x", e: "x" }));
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.n).toBe(3);
  });

  it("handles an empty gold set", () => {
    expect(bcubed(new Map(), grouping({ a: "x" })).n).toBe(0);
  });
});
