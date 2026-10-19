// tests/eval/constraint-labels.test.ts — the operator's corrections as grouping labels

import { describe, it, expect } from "vitest";
import { labelsFromConstraints } from "../../core/eval/constraint-labels.js";
import type { Constraint } from "../../core/graph/constraints.js";

function c(kind: Constraint["kind"], a: string, b: string | null, more: Partial<Constraint> = {}): Constraint {
  return { id: `${kind}-${a}`, kind, a, b, decidedBy: "operator", origin: null, createdAt: "t", retiredAt: null, suspendedAt: null, supersededBy: null, ...more };
}

const messageOf = (k: string) => (k.startsWith("obs") ? `slack:C0OPS:${k.slice(3)}` : null);

describe("labelsFromConstraints", () => {
  it("turns links, unlinks, pins and noise into pairs and not-work marks", () => {
    const labels = labelsFromConstraints([
      c("must_link", "obs1", "obs2"),
      c("cannot_link", "obs3", "obs4"),
      c("pin", "obs5", "ticket:OPS-1"),
      c("pin", "obs6", "ticket:OPS-1"),
      c("pin", "obs7", "ticket:OPS-1"),
      c("not_an_item", "obs8", null),
      c("key_alias", "ticket:OPS-1", "ticket:OPS-2"),
    ], messageOf);
    expect(labels.pairs.map((p) => [p.a, p.b, p.verdict, p.stratum])).toEqual([
      ["slack:C0OPS:1", "slack:C0OPS:2", "same", "operator:must_link"],
      ["slack:C0OPS:3", "slack:C0OPS:4", "different", "operator:cannot_link"],
      ["slack:C0OPS:5", "slack:C0OPS:6", "same", "operator:pin"],
      ["slack:C0OPS:6", "slack:C0OPS:7", "same", "operator:pin"],
    ]);
    expect(labels.notWork.map((n) => n.message)).toEqual(["slack:C0OPS:8"]);
  });

  it("leaves out suspended and retired constraints, and observations it can't map", () => {
    const labels = labelsFromConstraints([
      c("must_link", "obs1", "obs2", { suspendedAt: "t2" }),
      c("must_link", "obs1", "obs3", { retiredAt: "t2" }),
      c("must_link", "obs1", "other9"),
    ], messageOf);
    expect(labels.pairs).toEqual([]);
  });
});
