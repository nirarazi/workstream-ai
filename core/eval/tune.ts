#!/usr/bin/env node
// core/eval/tune.ts — Fit the v2 grouping's weights to the labelled pairs (dev only), and report the held-out score
//
// Usage: npm run eval:tune -- [--labels labels.<name>.json] [--db workstream.db]
// A coordinate search: each weight in turn is tried at a few multiples of its value, keeping whatever scores best on
// the dev half of the labels (pairwise F1), for two passes. Then the fitted weights and the defaults are both scored
// on the held-out test half, which the search never saw. Nothing is applied: if the fit holds up on test, change
// DEFAULT_WEIGHTS (core/grouping/cluster.ts) and record the run (npm run eval:linking -- --record). Re-run as labels
// grow (the operator's corrections become labels: npm run eval:constraint-labels).

import { resolve } from "node:path";
import { openReadOnly, type ReadOnlyCopy } from "../graph/relink.js";
import { cluster, DEFAULT_WEIGHTS, type Weights } from "../grouping/cluster.js";
import { loadMessageIndex, onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { loadLabels, splitOf, type LinkingLabels } from "./linking-labels.js";
import { scoreGrouping } from "./linking-metrics.js";
import { groupingMessages, v2Options } from "./v2-grouping.js";
import type { GroupingMessage } from "../grouping/recognize.js";

const MULTIPLES = [0.5, 0.75, 1, 1.25, 1.5];
const PASSES = 2;
/** The weights searched; sameKey and otherKeyInThread decide by sign more than by size, so they're left alone */
const TUNED: Array<keyof Weights> = ["thread", "namedSubject", "followUp", "continuation", "exchange", "nearCopy", "join"];

function f1(messages: GroupingMessage[], weights: Weights, labels: LinkingLabels, known: Set<string>): number {
  const placed = cluster(messages, v2Options({ weights }));
  const grouping = new Map<string, string>();
  for (const [k, p] of placed) if (p.cluster) grouping.set(k, p.cluster);
  return scoreGrouping(labels, grouping, known).pairwise.f1 ?? 0;
}

let openSource: ReadOnlyCopy | undefined;

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["labels", "db"] as const);
  const all = loadLabels(projectRoot(), flags.labels);
  const half = (s: "dev" | "test"): LinkingLabels => ({ ...all, pairs: all.pairs.filter((p) => splitOf(p.a, p.b) === s) });
  const [dev, test] = [half("dev"), half("test")];
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  let messages: GroupingMessage[];
  let known: Set<string>;
  try {
    const index = loadMessageIndex(source.db);
    known = new Set(index.rowOfMessage.keys());
    messages = groupingMessages(source.db, index);
  } finally {
    openSource = undefined;
    source.close();
  }

  let best: Weights = { ...DEFAULT_WEIGHTS };
  let bestF1 = f1(messages, best, dev, known);
  console.log(`defaults: dev F1 ${bestF1.toFixed(3)}`);
  for (let pass = 1; pass <= PASSES; pass++) {
    for (const name of TUNED) {
      for (const m of MULTIPLES) {
        if (m === 1) continue;
        const trial = { ...best, [name]: +(DEFAULT_WEIGHTS[name] * m).toFixed(2) };
        const score = f1(messages, trial, dev, known);
        if (score > bestF1 + 1e-9) {
          bestF1 = score;
          best = trial;
          console.log(`pass ${pass}: ${name} = ${trial[name]} → dev F1 ${score.toFixed(3)}`);
        }
      }
    }
  }
  const changed = TUNED.filter((k) => best[k] !== DEFAULT_WEIGHTS[k]).map((k) => `${k} ${DEFAULT_WEIGHTS[k]} → ${best[k]}`);
  console.log(`\nFitted: ${changed.length ? changed.join(", ") : "no change"}`);
  console.log(`dev F1   defaults ${f1(messages, DEFAULT_WEIGHTS, dev, known).toFixed(3)} · fitted ${bestF1.toFixed(3)}`);
  console.log(`test F1  defaults ${f1(messages, DEFAULT_WEIGHTS, test, known).toFixed(3)} · fitted ${f1(messages, best, test, known).toFixed(3)} (held out)`);
}

if (process.argv[1]?.endsWith("tune.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`eval:tune: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
