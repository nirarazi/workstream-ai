#!/usr/bin/env node
// core/eval/linking.ts — Score message groupings against the operator's pair verdicts
//
// Usage: npm run eval:linking -- [--grouping current,relink] [--db workstream.db] [--gold clusters.json] [--labels labels.<name>.json]
// Reads eval-data/linking/labels.json (npm run eval:pairs writes it) and prints, per grouping side by side: pairwise
// precision (low: unrelated work merged), recall (low: one piece of work split) and F1, the over-merged and split
// pair counts, the not-work rate among labeled messages in items, and how often each grouping agrees with the
// verdicts per sampling stratum. Rates carry Wilson 95% intervals. Pairs are drawn by stratum, so the numbers describe
// the labeled pairs, not all pairs. --gold adds B-cubed scores against a full clustering of message keys ({ "clusters": [[keys], …] }).
// By default it scores the current grouping, and the re-link proposal when npm run relink has written it. --labels
// scores against another label set in eval-data/linking/ instead of the operator's. --split dev or test scores one
// half of the pairs (linking-labels.ts, splitOf): tune on dev, report test. --errors <grouping> lists the dev pairs
// that grouping gets wrong, with a few words of each message (never test pairs, which stay unseen).

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
  type Observation,
} from "./linking-data.js";
import { loadLabels, splitOf } from "./linking-labels.js";
import { bcubed, scoreGrouping, together, type GroupingScore, type Rate } from "./linking-metrics.js";

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
  const flags = parseFlags(process.argv.slice(2), ["grouping", "db", "gold", "labels", "split", "errors"] as const);
  const root = projectRoot();
  const names = parseGroupingNames(flags.grouping ?? (existsSync(relinkItemsPath(root)) ? "current,relink" : "current"));
  const all = loadLabels(root, flags.labels);
  const split = flags.split ?? "all";
  if (split !== "all" && split !== "dev" && split !== "test") throw new Error("--split must be dev, test or all");
  if (flags.errors && split === "test") throw new Error("--errors lists dev pairs only: test pairs stay unseen");
  const labels = split === "all" ? all : { ...all, pairs: all.pairs.filter((p) => splitOf(p.a, p.b) === split) };
  if (labels.pairs.length === 0 && labels.notWork.length === 0 && labels.mixed.length === 0) {
    console.log("No linking labels yet. Run: npm run eval:pairs");
    return;
  }

  // Labels are keyed by message; the database maps each grouping's events to messages (the re-link proposal's too).
  // As npm run relink: the database in the directory it runs in, unless --db says otherwise.
  let loaded: LoadedGroupings;
  let known: Set<string>;
  let messages: Map<string, Observation>;
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const index = loadMessageIndex(source.db);
    known = new Set(index.rowOfMessage.keys());
    messages = new Map(index.observations.map((o) => [o.id, o]));
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
  console.log(`Labels: ${labels.pairs.length} pairs (${same} same work, ${labels.pairs.length - same} different), ${labels.notWork.length} messages marked not work, ${labels.mixed.length} mixed`);
  if (split !== "all") console.log(`Pairs from the ${split} split only; the not-work rate, unplaced count and B-cubed scores use every labelled message`);
  const first = [...scores.values()][0];
  if (first.unknownMessages) {
    console.log(`${first.unknownMessages} labeled messages aren't in this database (another or older --db?): ${first.pairsWithUnknown} pairs with them are left out`);
  }
  if (first.pairsWithNotWork) console.log(`${first.pairsWithNotWork} pairs with a not-work message are left out of the pairwise scores`);
  if (first.pairsWithMixed) console.log(`${first.pairsWithMixed} pairs with a mixed message (several cases) are left out too`);
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

  if (flags.errors) {
    const name = parseGroupingNames(flags.errors)[0];
    const grouping = groupings.get(name);
    if (!grouping) throw new Error(`--errors ${name}: add it to --grouping`);
    const notWork = new Set(labels.notWork.map((n) => n.message));
    const mixed = new Set(labels.mixed.map((n) => n.message));
    const wrong = labels.pairs.filter((p) => splitOf(p.a, p.b) === "dev" && !notWork.has(p.a) && !notWork.has(p.b)
      && !mixed.has(p.a) && !mixed.has(p.b) && known.has(p.a) && known.has(p.b)
      && together(grouping, p.a, p.b) !== (p.verdict === "same"));
    const gist = (id: string) => {
      const m = messages.get(id);
      return m ? `${clean(m.senderName)} #${clean(m.channelName)} ${m.timestamp.slice(0, 16)}: ${clean(m.text.replace(/\s+/g, " ").slice(0, 140))}` : clean(id);
    };
    console.log(`\n${name} gets ${wrong.length} dev pairs wrong:`);
    for (const p of wrong) {
      console.log(`\n[${p.verdict === "same" ? "split" : "over-merged"} · ${clean(p.stratum ?? "?")}] ${clean(p.a)}  ${clean(p.b)}`);
      console.log(`  A ${gist(p.a)}`);
      console.log(`  B ${gist(p.b)}`);
      if (p.note) console.log(`  note: ${clean(p.note)}`);
    }
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
