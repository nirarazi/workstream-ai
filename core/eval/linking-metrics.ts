// core/eval/linking-metrics.ts — Scoring a grouping of messages into work items against the operator's verdicts (pure)
//
// A grouping maps a message (its key, see messageKey in linking-data.ts) to the work item it's in; a message it doesn't place is in no item. Labels
// are pairs judged "same work" or "different work", so the main scores are pairwise: precision (of the labeled pairs
// the grouping puts together, how many are truly the same work: low means unrelated work merged) and recall (of the
// pairs that are the same work, how many it puts together: low means one piece of work split). Labeled sets are
// small, so every rate comes with a Wilson 95% interval. Pairs are drawn by stratum, not uniformly, so these describe
// the labeled pairs, not every pair in the database. B-cubed scores a grouping against a full gold clustering.

import type { PairVerdict } from "./linking-labels.js";

/** Message key → work item id. A message missing from the map is in no item. */
export type Grouping = ReadonlyMap<string, string>;

export interface Rate {
  k: number;
  n: number;
  /** k / n, or null when n is 0 */
  p: number | null;
  /** Wilson score interval (95% by default) */
  lo: number;
  hi: number;
}

/** A proportion k/n with its Wilson score interval, which stays sensible at small n and at 0 or n successes */
export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n <= 0) return { k: 0, n: 0, p: null, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface LabeledPair {
  a: string;
  b: string;
  verdict: PairVerdict;
  stratum?: string;
}

/** Whether the grouping puts both messages in the same item */
export function together(grouping: Grouping, a: string, b: string): boolean {
  const ia = grouping.get(a);
  return ia !== undefined && ia === grouping.get(b);
}

export interface PairwiseScores {
  /** together & same */
  tp: number;
  /** together & different: unrelated work merged */
  fp: number;
  /** apart & same: one piece of work split */
  fn: number;
  /** apart & different */
  tn: number;
  precision: Rate;
  recall: Rate;
  /** null when precision or recall is undefined */
  f1: number | null;
}

export function pairwiseScores(pairs: LabeledPair[], grouping: Grouping): PairwiseScores {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const pair of pairs) {
    const t = together(grouping, pair.a, pair.b);
    if (pair.verdict === "same") t ? tp++ : fn++;
    else t ? fp++ : tn++;
  }
  const precision = wilson(tp, tp + fp);
  const recall = wilson(tp, tp + fn);
  const f1 = precision.p === null || recall.p === null ? null
    : precision.p + recall.p === 0 ? 0
    : (2 * precision.p * recall.p) / (precision.p + recall.p);
  return { tp, fp, fn, tn, precision, recall, f1 };
}

/**
 * Of the labeled messages the grouping puts in an item, how many the operator marked "not work". `labeled` is every
 * message the operator saw (in a labeled pair, or marked), since each could have been marked.
 */
export function notWorkRate(labeled: Iterable<string>, notWork: ReadonlySet<string>, grouping: Grouping): Rate {
  let k = 0, n = 0;
  for (const id of new Set(labeled)) {
    if (!grouping.has(id)) continue;
    n++;
    if (notWork.has(id)) k++;
  }
  return wilson(k, n);
}

export interface StratumRow {
  pairs: number;
  same: number;
  /** Pairs the grouping puts together */
  together: number;
  /** Pairs where the grouping agrees with the verdict (together and same, or apart and different) */
  agree: number;
}

/** Per sampling stratum: the verdicts, and how often the grouping agrees with them */
export function byStratum(pairs: LabeledPair[], grouping: Grouping): Record<string, StratumRow> {
  const out: Record<string, StratumRow> = {};
  for (const pair of pairs) {
    const row = (out[pair.stratum ?? "unknown"] ??= { pairs: 0, same: 0, together: 0, agree: 0 });
    const t = together(grouping, pair.a, pair.b);
    row.pairs++;
    if (pair.verdict === "same") row.same++;
    if (t) row.together++;
    if (t === (pair.verdict === "same")) row.agree++;
  }
  return out;
}

export interface GroupingScore {
  pairwise: PairwiseScores;
  notWork: Rate;
  strata: Record<string, StratumRow>;
  /** Labeled messages the grouping puts in no item */
  unplaced: number;
  /** Labeled pairs left out of the pairwise scores because a message in them isn't work */
  pairsWithNotWork: number;
}

/**
 * Scores a grouping against a label set. A pair with a message marked "not work" is left out of the pairwise scores:
 * that message shouldn't be in any item, which the not-work rate counts instead.
 */
export function scoreGrouping(labels: { pairs: LabeledPair[]; notWork: Array<{ message: string }> }, grouping: Grouping): GroupingScore {
  const notWork = new Set(labels.notWork.map((n) => n.message));
  const work = labels.pairs.filter((p) => !notWork.has(p.a) && !notWork.has(p.b));
  const seen = new Set([...labels.pairs.flatMap((p) => [p.a, p.b]), ...notWork]);
  return {
    pairwise: pairwiseScores(work, grouping),
    notWork: notWorkRate(seen, notWork, grouping),
    strata: byStratum(work, grouping),
    unplaced: [...seen].filter((id) => !grouping.has(id)).length,
    pairsWithNotWork: labels.pairs.length - work.length,
  };
}

export interface BCubed {
  precision: number;
  recall: number;
  f1: number;
  /** Messages scored: those in the gold clustering */
  n: number;
}

function clusters(grouping: Grouping, only: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, item] of grouping) {
    if (!only.has(id)) continue;
    const set = out.get(item) ?? new Set<string>();
    set.add(id);
    out.set(item, set);
  }
  return out;
}

/**
 * B-cubed precision and recall of a predicted clustering against a gold one, over the gold clustering's messages.
 * A message the prediction doesn't place counts as an item of its own. Each message's precision is the share of its
 * predicted item that's in its gold item, and its recall the share of its gold item that's in its predicted item.
 */
export function bcubed(gold: Grouping, predicted: Grouping): BCubed {
  const ids = new Set(gold.keys());
  if (ids.size === 0) return { precision: 0, recall: 0, f1: 0, n: 0 };
  const goldClusters = clusters(gold, ids);
  const predClusters = clusters(predicted, ids);
  let p = 0, r = 0;
  for (const id of ids) {
    const g = goldClusters.get(gold.get(id)!)!;
    const item = predicted.get(id);
    const pc = item === undefined ? new Set([id]) : predClusters.get(item)!;
    let overlap = 0;
    for (const other of pc) if (g.has(other)) overlap++;
    p += overlap / pc.size;
    r += overlap / g.size;
  }
  const precision = p / ids.size;
  const recall = r / ids.size;
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall), n: ids.size };
}
