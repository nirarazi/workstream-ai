// tests/eval/agreement.test.ts — two labelers' answers on the same pairs, and how far they agree

import { describe, it, expect } from "vitest";
import { agreement, answers } from "../../core/eval/agreement.js";
import { emptyLabels, setMark, setPairLabel, type LinkingLabels } from "../../core/eval/linking-labels.js";

function labels(build: (l: LinkingLabels) => void): LinkingLabels {
  const l = emptyLabels();
  build(l);
  return l;
}

describe("answers and agreement", () => {
  it("answers not work before mixed, and mixed before the pair's verdict", () => {
    const l = labels((l) => {
      setPairLabel(l, { a: "m1", b: "m2", verdict: "same", labeledAt: "t" });
      setPairLabel(l, { a: "m2", b: "m3", verdict: "different", labeledAt: "t" });
      setPairLabel(l, { a: "m3", b: "m4", verdict: "same", labeledAt: "t" });
      setPairLabel(l, { a: "m5", b: "m6", verdict: "different", labeledAt: "t" });
      setMark(l, "mixed", "m3", true, "t");
      setMark(l, "notWork", "m4", true, "t");
    });
    expect([...answers(l).values()].map((a) => a.answer)).toEqual(["same", "mixed", "not work", "different"]);
  });

  it("computes Cohen's kappa over the pairs both labeled", () => {
    const x = labels((l) => {
      setPairLabel(l, { a: "m1", b: "m2", verdict: "same", labeledAt: "t" });
      setPairLabel(l, { a: "m3", b: "m4", verdict: "different", labeledAt: "t" });
      setPairLabel(l, { a: "m5", b: "m6", verdict: "same", labeledAt: "t" });
    });
    const y = labels((l) => {
      setPairLabel(l, { a: "m1", b: "m2", verdict: "same", labeledAt: "t" });
      setPairLabel(l, { a: "m3", b: "m4", verdict: "different", labeledAt: "t" });
    });
    expect(agreement(answers(x), answers(y))).toEqual({ n: 2, agreed: 2, kappa: 1 });
  });
});
