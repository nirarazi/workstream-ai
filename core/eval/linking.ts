#!/usr/bin/env node
// core/eval/linking.ts — Score message groupings against the operator's pair verdicts
//
// Usage: npm run eval:linking -- [--grouping current,relink] [--db workstream.db] [--gold clusters.json]
// Reads eval-data/linking/labels.json (npm run eval:pairs writes it) and prints, per grouping side by side: pairwise
// precision (low: unrelated work merged), recall (low: one piece of work split) and F1, the over-merged and split
// pair counts, the not-work rate among labeled messages in items, and how often each grouping agrees with the
// verdicts per sampling stratum. Rates carry Wilson 95% intervals. Pairs are drawn by stratum, so the numbers describe
// the labeled pairs, not all pairs. --gold adds B-cubed scores against a full clustering of message keys ({ "clusters": [[keys], …] }).
// By default it scores the current grouping, and the re-link proposal when npm run relink has written it.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openReadOnly, type ReadOnlyCopy } from "../graph/relink.js";
import { clean } from "./terminal.js";
import {
  loadGroupings,
  loadMessageIndex,
  onStopSignals,
  parseFlags,
  parseGoldClusters,
  parseGroupingNames,
  projectRoot,
  relinkItemsPath,
  type GroupingName,
  type LoadedGroupings,
} from "./linking-data.js";
import { loadLabels } from "./linking-labels.js";
import { bcubed, scoreGrouping, type GroupingScore, type Rate } from "./linking-metrics.js";

const LABEL_WIDTH = 22;
const COLUMN_WIDTH = 28;

function rate(r: Rate): string {
  if (r.p === null) return "—";
  return `${r.p.toFixed(2)} [${r.lo.toFixed(2)}–${r.hi.toFixed(2)}] ${r.k}/${r.n}`;
}

function row(label: string, cells: string[]): string {
  return label.padEnd(LABEL_WIDTH) + cells.map((c) => c.padEnd(COLUMN_WIDTH)).join("");
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["grouping", "db", "gold"] as const);
  const root = projectRoot();
  const names = parseGroupingNames(flags.grouping ?? (existsSync(relinkItemsPath(root)) ? "current,relink" : "current"));
  const labels = loadLabels(root);
  if (labels.pairs.length === 0 && labels.notWork.length === 0) {
    console.log("No linking labels yet. Run: npm run eval:pairs");
    return;
  }

  // Labels are keyed by message; the database maps each grouping's events to messages (the re-link proposal's too).
  // As npm run relink: the database in the directory it runs in, unless --db says otherwise.
  let loaded: LoadedGroupings;
  let known: Set<string>;
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const index = loadMessageIndex(source.db);
    known = new Set(index.rowOfMessage.keys());
    loaded = loadGroupings(names, root, source.db, index);
  } finally {
    openSource = undefined;
    source.close();
  }
  const { groupings } = loaded;
  for (const [name, n] of loaded.unmatched) {
    if (n) console.log(`${name}: ${n} events it places aren't in the database (made from an older copy?); they're left out`);
  }

  const scores = new Map<GroupingName, GroupingScore>([...groupings].map(([name, g]) => [name, scoreGrouping(labels, g, known)]));
  const same = labels.pairs.filter((p) => p.verdict === "same").length;
  console.log(`Labels: ${labels.pairs.length} pairs (${same} same work, ${labels.pairs.length - same} different), ${labels.notWork.length} messages marked not work`);
  const first = [...scores.values()][0];
  if (first.unknownMessages) {
    console.log(`${first.unknownMessages} labeled messages aren't in this database (another or older --db?): ${first.pairsWithUnknown} pairs with them are left out`);
  }
  if (first.pairsWithNotWork) console.log(`${first.pairsWithNotWork} pairs with a not-work message are left out of the pairwise scores`);
  console.log("");

  const cols = [...scores.values()];
  console.log(row("", names));
  console.log(row("precision", cols.map((s) => rate(s.pairwise.precision))));
  console.log(row("recall", cols.map((s) => rate(s.pairwise.recall))));
  console.log(row("F1", cols.map((s) => (s.pairwise.f1 === null ? "—" : s.pairwise.f1.toFixed(2)))));
  console.log(row("over-merged pairs", cols.map((s) => String(s.pairwise.fp))));
  console.log(row("split pairs", cols.map((s) => String(s.pairwise.fn))));
  console.log(row("not-work rate", cols.map((s) => rate(s.notWork))));
  console.log(row("labeled, in no item", cols.map((s) => String(s.unplaced))));

  const strata = [...new Set(cols.flatMap((s) => Object.keys(s.strata)))].sort();
  console.log(`\nBy stratum (pairs the grouping gets right / pairs; "same" = judged the same work)`);
  console.log(row("stratum", ["pairs · same", ...names]));
  for (const stratum of strata) {
    const first = cols[0].strata[stratum];
    console.log(row(clean(stratum), [`${first.pairs} · ${first.same}`, ...cols.map((s) => `${s.strata[stratum].agree}/${s.strata[stratum].pairs}`)]));
  }

  if (flags.gold) {
    const gold = parseGoldClusters(readFileSync(resolve(flags.gold), "utf-8"));
    console.log(`\nB-cubed against the gold clustering (${gold.size} messages)`);
    const b = [...groupings.values()].map((g) => bcubed(gold, g));
    console.log(row("precision", b.map((x) => x.precision.toFixed(2))));
    console.log(row("recall", b.map((x) => x.recall.toFixed(2))));
    console.log(row("F1", b.map((x) => x.f1.toFixed(2))));
  }
}

/** The database copy while it's open, for the signal handler to remove */
let openSource: ReadOnlyCopy | undefined;
// Before the copy is opened, so a signal at any point removes it
onStopSignals(() => {
  const copy = openSource;
  openSource = undefined;
  copy?.close();
});

try {
  main();
} catch (err) {
  console.error(`eval:linking: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
