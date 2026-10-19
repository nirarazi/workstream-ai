#!/usr/bin/env node
// core/eval/agreement.ts — How often two labelers agree on the same pairs
//
// Usage: npm run eval:agreement -- --other labels.<name>.json
// Compares the operator's labels (eval-data/linking/labels.json) with another label set on the pairs both labeled.
// Each pair gets one of three answers per labeler: same work, different work, or not work (either message marked
// not work). Prints the agreement rate, Cohen's kappa, and every pair they disagree on, with both notes.

import { pairKey, loadLabels, type LinkingLabels } from "./linking-labels.js";
import { parseFlags, projectRoot } from "./linking-data.js";
import { clean } from "./terminal.js";

type Answer = "same" | "different" | "not work";
const ANSWERS: Answer[] = ["same", "different", "not work"];

interface Answered {
  answer: Answer;
  stratum?: string;
  note?: string;
}

/** Each labeled pair's three-way answer, keyed by pairKey() */
export function answers(labels: LinkingLabels): Map<string, Answered> {
  const notWork = new Set(labels.notWork.map((n) => n.message));
  const out = new Map<string, Answered>();
  for (const p of labels.pairs) {
    const answer: Answer = notWork.has(p.a) || notWork.has(p.b) ? "not work" : p.verdict;
    out.set(pairKey(p.a, p.b), { answer, stratum: p.stratum, note: p.note });
  }
  return out;
}

/** Observed agreement and Cohen's kappa over the pairs both sets answered */
export function agreement(x: Map<string, Answered>, y: Map<string, Answered>): { n: number; agreed: number; kappa: number | null } {
  const shared = [...x.keys()].filter((k) => y.has(k));
  const n = shared.length;
  if (n === 0) return { n, agreed: 0, kappa: null };
  const agreed = shared.filter((k) => x.get(k)!.answer === y.get(k)!.answer).length;
  const po = agreed / n;
  const share = (m: Map<string, Answered>, a: Answer) => shared.filter((k) => m.get(k)!.answer === a).length / n;
  const pe = ANSWERS.reduce((sum, a) => sum + share(x, a) * share(y, a), 0);
  return { n, agreed, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["other"] as const);
  if (!flags.other) throw new Error("--other labels.<name>.json is required");
  const root = projectRoot();
  const operator = answers(loadLabels(root));
  const other = answers(loadLabels(root, flags.other));
  const { n, agreed, kappa } = agreement(operator, other);
  console.log(`Pairs both labeled: ${n} (operator ${operator.size}, ${clean(flags.other)} ${other.size})`);
  if (n === 0) return;
  console.log(`Agreement: ${agreed}/${n} (${((agreed / n) * 100).toFixed(0)}%) · Cohen's kappa ${kappa === null ? "—" : kappa.toFixed(2)}\n`);
  for (const [key, mine] of operator) {
    const theirs = other.get(key);
    if (!theirs || theirs.answer === mine.answer) continue;
    const [a, b] = key.split("\u0000");
    console.log(`${clean(a)}  ${clean(b)}  [${clean(mine.stratum ?? "?")}]`);
    console.log(`  operator: ${mine.answer}${mine.note ? ` — ${clean(mine.note)}` : ""}`);
    console.log(`  other:    ${theirs.answer}${theirs.note ? ` — ${clean(theirs.note)}` : ""}`);
  }
}

if (process.argv[1]?.endsWith("agreement.ts")) {
  try {
    main();
  } catch (err) {
    console.error(`eval:agreement: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
