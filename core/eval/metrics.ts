// core/eval/metrics.ts — Scoring for classifier eval runs (pure functions)
//
// Beyond accuracy, this measures what CLAUDE.md says matters: how often the inbox
// interrupts the operator unnecessarily, and how often it misses something they needed.

import type { StatusCategory } from "../types.js";
import { STATUSES } from "./dataset.js";

export interface Prediction {
  status: StatusCategory;
  confidence: number;
  targetedAtOperator: boolean;
  statusProbabilities?: Record<StatusCategory, number>;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface Truth {
  status: StatusCategory;
  targetedAtOperator: boolean;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface InterruptMetrics {
  /** Items that truly needed the operator. */
  needed: number;
  /** Items the inbox would have surfaced. */
  surfaced: number;
  /** Surfaced but not needed — the number CLAUDE.md says to drive to zero. */
  unnecessary: number;
  /** Needed but not surfaced — the operator would have had to open Slack. */
  missed: number;
  precision: number;
  recall: number;
}

export interface EvalReport {
  n: number;
  errors: number;
  statusAccuracy: number;
  macroF1: number;
  perClass: Record<StatusCategory, ClassMetrics>;
  /** confusion[truth][predicted] */
  confusion: Record<StatusCategory, Record<StatusCategory, number>>;
  targetedAccuracy: number;
  interrupts: InterruptMetrics;
  /** Expected calibration error of status confidence (10 bins). Lower is better. */
  ece: number;
  /** Only for backends that return status probabilities. */
  thresholdSweep?: Array<{ threshold: number } & InterruptMetrics>;
  latencyMs: { p50: number; p95: number };
  tokens: { input: number; output: number };
  meetsTarget: boolean;
}

export const ACCURACY_TARGET = 0.8;

const ACTIONABLE = new Set<StatusCategory>(["blocked_on_human", "needs_decision"]);

export function needsOperator(t: Truth): boolean {
  return ACTIONABLE.has(t.status) && t.targetedAtOperator;
}

export function wouldSurface(p: Pick<Prediction, "status" | "targetedAtOperator">): boolean {
  return ACTIONABLE.has(p.status) && p.targetedAtOperator;
}

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function interruptMetrics(pairs: Array<{ surfaced: boolean; needed: boolean }>): InterruptMetrics {
  let surfaced = 0, needed = 0, hit = 0;
  for (const p of pairs) {
    if (p.surfaced) surfaced++;
    if (p.needed) needed++;
    if (p.surfaced && p.needed) hit++;
  }
  return {
    needed,
    surfaced,
    unnecessary: surfaced - hit,
    missed: needed - hit,
    precision: ratio(hit, surfaced),
    recall: ratio(hit, needed),
  };
}

export function expectedCalibrationError(points: Array<{ confidence: number; correct: boolean }>, bins = 10): number {
  if (points.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({ n: 0, conf: 0, correct: 0 }));
  for (const p of points) {
    const b = buckets[Math.min(bins - 1, Math.floor(p.confidence * bins))];
    b.n++;
    b.conf += p.confidence;
    b.correct += p.correct ? 1 : 0;
  }
  return buckets.reduce((acc, b) => acc + (b.n === 0 ? 0 : (b.n / points.length) * Math.abs(b.conf / b.n - b.correct / b.n)), 0);
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function scoreRun(results: Array<{ truth: Truth; prediction: Prediction }>): EvalReport {
  const ok = results.filter((r) => !r.prediction.error);
  const n = ok.length;

  const confusion = Object.fromEntries(
    STATUSES.map((t) => [t, Object.fromEntries(STATUSES.map((p) => [p, 0]))]),
  ) as EvalReport["confusion"];
  for (const r of ok) confusion[r.truth.status][r.prediction.status]++;

  const perClass = {} as EvalReport["perClass"];
  for (const s of STATUSES) {
    const tp = confusion[s][s];
    const support = STATUSES.reduce((a, p) => a + confusion[s][p], 0);
    const predicted = STATUSES.reduce((a, t) => a + confusion[t][s], 0);
    const precision = ratio(tp, predicted);
    const recall = ratio(tp, support);
    perClass[s] = { precision, recall, f1: ratio(2 * precision * recall, precision + recall), support };
  }
  const present = STATUSES.filter((s) => perClass[s].support > 0);
  const macroF1 = ratio(present.reduce((a, s) => a + perClass[s].f1, 0), present.length);

  const correct = ok.filter((r) => r.truth.status === r.prediction.status).length;
  const statusAccuracy = ratio(correct, n);

  const report: EvalReport = {
    n,
    errors: results.length - n,
    statusAccuracy,
    macroF1,
    perClass,
    confusion,
    targetedAccuracy: ratio(ok.filter((r) => r.truth.targetedAtOperator === r.prediction.targetedAtOperator).length, n),
    interrupts: interruptMetrics(ok.map((r) => ({ surfaced: wouldSurface(r.prediction), needed: needsOperator(r.truth) }))),
    ece: expectedCalibrationError(ok.map((r) => ({ confidence: r.prediction.confidence, correct: r.truth.status === r.prediction.status }))),
    latencyMs: { p50: percentile(ok.map((r) => r.prediction.latencyMs), 0.5), p95: percentile(ok.map((r) => r.prediction.latencyMs), 0.95) },
    tokens: {
      input: ok.reduce((a, r) => a + (r.prediction.inputTokens ?? 0), 0),
      output: ok.reduce((a, r) => a + (r.prediction.outputTokens ?? 0), 0),
    },
    meetsTarget: statusAccuracy >= ACCURACY_TARGET,
  };

  // If the backend gives a distribution, show how the interrupt trade-off moves with a
  // threshold on P(blocked_on_human) + P(needs_decision).
  if (ok.length > 0 && ok.every((r) => r.prediction.statusProbabilities)) {
    report.thresholdSweep = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => ({
      threshold,
      ...interruptMetrics(ok.map((r) => {
        const p = r.prediction.statusProbabilities!;
        const pActionable = (p.blocked_on_human ?? 0) + (p.needs_decision ?? 0);
        return { surfaced: pActionable >= threshold && r.prediction.targetedAtOperator, needed: needsOperator(r.truth) };
      })),
    }));
  }

  return report;
}

export function formatReport(name: string, r: EvalReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `## ${name}`,
    `n=${r.n}${r.errors ? `  (errors: ${r.errors})` : ""}`,
    `status accuracy  ${pct(r.statusAccuracy)}  ${r.meetsTarget ? "✓ meets" : "✗ below"} ${pct(ACCURACY_TARGET)} target`,
    `macro F1         ${r.macroF1.toFixed(3)}`,
    `inbox accuracy   ${pct(r.targetedAccuracy)}`,
    `calibration ECE  ${r.ece.toFixed(3)}`,
    `interrupts       surfaced ${r.interrupts.surfaced}, unnecessary ${r.interrupts.unnecessary}, missed ${r.interrupts.missed} of ${r.interrupts.needed} needed  (precision ${pct(r.interrupts.precision)}, recall ${pct(r.interrupts.recall)})`,
    `latency          p50 ${r.latencyMs.p50}ms  p95 ${r.latencyMs.p95}ms`,
    `tokens           in ${r.tokens.input}  out ${r.tokens.output}`,
    "",
    "per class        precision  recall  f1     support",
    ...STATUSES.map((s) => {
      const c = r.perClass[s];
      return `  ${s.padEnd(16)} ${pct(c.precision).padStart(7)}  ${pct(c.recall).padStart(6)}  ${c.f1.toFixed(2).padStart(4)}  ${String(c.support).padStart(5)}`;
    }),
    "",
    "confusion (rows = truth, cols = predicted: C I B D N)",
    ...STATUSES.map((t) => `  ${t.padEnd(16)} ${STATUSES.map((p) => String(r.confusion[t][p]).padStart(4)).join("")}`),
  ];
  if (r.thresholdSweep) {
    lines.push("", "interrupt threshold on P(blocked)+P(decision)");
    for (const s of r.thresholdSweep) {
      lines.push(`  ≥${s.threshold.toFixed(1)}  surfaced ${String(s.surfaced).padStart(3)}  unnecessary ${String(s.unnecessary).padStart(3)}  missed ${String(s.missed).padStart(3)}`);
    }
  }
  return lines.join("\n");
}
