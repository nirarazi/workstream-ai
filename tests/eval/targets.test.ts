// tests/eval/targets.test.ts — pairs drawn where a grouping decision acts

import { describe, it, expect } from "vitest";
import { drawTargets } from "../../core/eval/targets.js";
import type { Placement } from "../../core/grouping/cluster.js";

function p(cluster: string, about: string | null, via: string | null, reason: string): Placement {
  return { cluster, via, viaReason: via ? reason.split(/[ ,:]/)[0] : null, reasons: [reason], recognized: { kind: "work", about, aboutBy: about ? "key" : null, mentions: [], lane: null, asks: false } };
}

describe("drawTargets", () => {
  it("draws the edge and a pair across each proposed split, and a pair across each subject's case break", () => {
    const clustered = new Map<string, Placement>([
      ["a1", p("c1", "ticket:OPS-1", null, "new")],
      ["a2", p("c1", "ticket:OPS-1", "a1", "sameKey +10")],
      ["b1", p("c1", "ticket:OPS-2", "a2", "exchange +3")],
      ["b2", p("c1", null, "b1", "thread +6")],
      ["s1", p("c2", "subject:northwind", null, "new")],
      ["s2", p("c3", "subject:northwind", null, "new")],
    ]);
    const at = new Map([...clustered.keys()].map((k, i) => [k, { at: `2026-10-0${i + 1}T00:00:00.000Z`, channelId: "C0OPS" }]));
    const targets = drawTargets(clustered, clustered, at);
    expect(targets.filter((t) => t.decision === "split-edge")).toEqual([{ a: "a2", b: "b1", decision: "split-edge" }]);
    const across = targets.find((t) => t.decision === "split-across")!;
    expect(["a1", "a2"]).toContain(across.a);
    expect(["b1", "b2"]).toContain(across.b);
    expect(targets.filter((t) => t.decision === "subject-window")).toEqual([{ a: "s1", b: "s2", decision: "subject-window" }]);
  });
});
