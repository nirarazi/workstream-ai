// tests/eval/metrics.test.ts — Eval scoring: accuracy, interrupts, calibration

import { describe, it, expect } from "vitest";
import { expectedCalibrationError, interruptMetrics, scoreRun, type Prediction, type Truth } from "../../core/eval/metrics.js";
import type { StatusCategory } from "../../core/types.js";

function pair(truth: StatusCategory, predicted: StatusCategory, opts: Partial<Prediction> & { truthTargeted?: boolean } = {}) {
  const { truthTargeted = true, ...pred } = opts;
  const t: Truth = { status: truth, targetedAtOperator: truthTargeted };
  const p: Prediction = { status: predicted, confidence: 0.9, targetedAtOperator: true, latencyMs: 10, ...pred };
  return { truth: t, prediction: p };
}

describe("scoreRun", () => {
  it("computes accuracy, confusion, and per-class metrics", () => {
    const r = scoreRun([
      pair("completed", "completed"),
      pair("noise", "noise"),
      pair("noise", "in_progress"),
      pair("blocked_on_human", "blocked_on_human"),
    ]);
    expect(r.n).toBe(4);
    expect(r.statusAccuracy).toBe(0.75);
    expect(r.confusion.noise.in_progress).toBe(1);
    expect(r.perClass.noise.recall).toBe(0.5);
    expect(r.perClass.in_progress.precision).toBe(0);
    expect(r.meetsTarget).toBe(false);
  });

  it("counts unnecessary and missed interrupts", () => {
    const r = scoreRun([
      pair("blocked_on_human", "blocked_on_human"),       // hit
      pair("noise", "needs_decision"),                     // unnecessary
      pair("needs_decision", "in_progress"),               // missed
      pair("blocked_on_human", "blocked_on_human", { truthTargeted: false }), // unnecessary: someone else handles it
    ]);
    expect(r.interrupts).toMatchObject({ needed: 2, surfaced: 3, unnecessary: 2, missed: 1 });
  });

  it("excludes errored predictions from scoring", () => {
    const r = scoreRun([pair("noise", "noise"), pair("noise", "noise", { error: "boom" })]);
    expect(r.n).toBe(1);
    expect(r.errors).toBe(1);
  });

  it("adds a threshold sweep only when every prediction has probabilities", () => {
    const probs = { completed: 0, in_progress: 0.4, blocked_on_human: 0.6, needs_decision: 0, noise: 0 };
    expect(scoreRun([pair("noise", "noise")]).thresholdSweep).toBeUndefined();
    const r = scoreRun([pair("blocked_on_human", "blocked_on_human", { statusProbabilities: probs })]);
    const at05 = r.thresholdSweep!.find((s) => s.threshold === 0.5)!;
    const at07 = r.thresholdSweep!.find((s) => s.threshold === 0.7)!;
    expect(at05.surfaced).toBe(1);
    expect(at07.missed).toBe(1);
  });
});

describe("helpers", () => {
  it("interruptMetrics handles empty input", () => {
    expect(interruptMetrics([])).toMatchObject({ precision: 0, recall: 0 });
  });

  it("ECE is 0 when confidence matches accuracy and large when overconfident", () => {
    expect(expectedCalibrationError([{ confidence: 1, correct: true }])).toBe(0);
    expect(expectedCalibrationError([
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: false },
    ])).toBeCloseTo(0.95);
  });
});
