#!/usr/bin/env node
// core/eval/targets.ts — Pairs drawn where a grouping decision acts, so each decision is measured, not assumed
//
// Usage: npm run eval:targets -- [--db workstream.db] [--per-decision 15] [--report labels.<name>.json]
// Random pairs rarely land where a rule acts: the over-merge detector proposes a handful of splits in a whole history,
// and a subject's window breaks only long-running partners. This draws pairs exactly there, from a read-only copy:
//   split-edge     the weak edge each proposed split cuts (the split is right if these are different work)
//   split-across   a message on each side of a proposed split
//   subject-window the last message of a subject's case and the first of the next case in the same stream
//   join:<rule>    a message and the one that drew it in, where that rule decided the join (exchange, continuation,
//                  followUp, nearCopy, namedSubject): the join is right if these are the same work
// and writes them to eval-data/linking/targets.json ({ pairs: [{ a, b }] }, for npm run eval:pairs -- --only
// targets.json) with targets-why.json, which says which decision each pair tests. --report tallies the verdicts a
// label set gives those pairs, per decision: the share judged different is the decision's precision.

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { DefaultExtractor } from "../graph/extractors/default.js";
import { groupMessages } from "../grouping/index.js";
import { loadGroupingMessages } from "../grouping/load.js";
import { proposeSplits } from "../grouping/split.js";
import { casesFrom } from "../grouping/streams.js";
import { onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { LINKING_DIR, loadLabels, pairKey, projectFile } from "./linking-labels.js";
import type { Placement } from "../grouping/cluster.js";

export type Decision =
  | "split-edge" | "split-across" | "subject-window"
  | "join:exchange" | "join:continuation" | "join:followUp" | "join:nearCopy" | "join:namedSubject";

/** The join rules measured: a message and the one that drew it in, where that rule decided the join */
const JOINS = ["exchange", "continuation", "followUp", "nearCopy", "namedSubject"] as const;

export interface Target {
  a: string;
  b: string;
  decision: Decision;
}

/** A small seeded generator, so the same history gives the same targets */
function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Pure. Targets for the decisions the placements embody: `clustered` before the splits (the splits are proposed on
 * it), `placed` after them, `at` each message's time and channel.
 */
export function drawTargets(
  clustered: ReadonlyMap<string, Placement>,
  placed: ReadonlyMap<string, Placement>,
  at: ReadonlyMap<string, { at: string; channelId: string | null }>,
  perDecision = 15,
  seed = 7,
): Target[] {
  const rnd = seeded(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const out: Target[] = [];
  for (const s of proposeSplits(clustered).slice(0, perDecision)) {
    const rest = [...clustered].filter(([k, p]) => p.cluster === s.cluster && !s.moved.includes(k)).map(([k]) => k);
    out.push({ a: s.via, b: s.at, decision: "split-edge" });
    out.push({ a: pick(rest), b: pick(s.moved), decision: "split-across" });
  }
  const { cases, streams } = casesFrom(placed, at);
  const byId = new Map(cases.map((c) => [c.id, c]));
  let windows = 0;
  for (const st of streams) {
    if (!st.key.startsWith("subject:") || st.cases.length < 2) continue;
    const cs = st.cases.map((id) => byId.get(id)!).sort((x, y) => (x.first < y.first ? -1 : 1));
    out.push({ a: cs[0].members[cs[0].members.length - 1].key, b: cs[1].members[0].key, decision: "subject-window" });
    if (++windows >= perDecision) break;
  }
  for (const rule of JOINS) {
    const joined = [...placed].filter(([, p]) => p.via && (p.reasons[0] ?? "").startsWith(rule)).map(([k, p]) => ({ a: p.via!, b: k }));
    for (let i = 0; i < perDecision && joined.length > 0; i++) {
      const [j] = joined.splice(Math.floor(rnd() * joined.length), 1);
      out.push({ ...j, decision: `join:${rule}` });
    }
  }
  return out;
}

let openSource: ReadOnlyCopy | undefined;

function report(root: string, labelsFile: string): void {
  const path = projectFile(root, LINKING_DIR, "targets-why.json");
  if (!path) throw new Error("No targets yet: run npm run eval:targets first");
  const targets = JSON.parse(readFileSync(path, "utf8")) as Target[];
  const labels = loadLabels(root, labelsFile);
  const verdict = new Map(labels.pairs.map((p) => [pairKey(p.a, p.b), p.verdict]));
  const notWork = new Set(labels.notWork.map((n) => n.message));
  const tally = new Map<Decision, { different: number; same: number; notWork: number; unlabelled: number }>();
  for (const t of targets) {
    const row = tally.get(t.decision) ?? { different: 0, same: 0, notWork: 0, unlabelled: 0 };
    const v = verdict.get(pairKey(t.a, t.b));
    if (notWork.has(t.a) || notWork.has(t.b)) row.notWork++;
    else if (v === "different") row.different++;
    else if (v === "same") row.same++;
    else row.unlabelled++;
    tally.set(t.decision, row);
  }
  for (const [decision, r] of tally) {
    const judged = r.different + r.same;
    // A split or a window break is right when the pair is different work; a join when it's the same
    const right = decision.startsWith("join:") ? r.same : r.different;
    const precision = judged ? `${Math.round((100 * right) / judged)}% right` : "none judged yet";
    console.log(`${decision.padEnd(15)} ${precision} (${r.different} different, ${r.same} same, ${r.notWork} not work, ${r.unlabelled} unlabelled)`);
  }
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["db", "per-decision", "report"] as const);
  const root = projectRoot();
  if (flags.report) return report(root, flags.report);
  const perDecision = Number(flags["per-decision"] ?? "15");
  if (!Number.isInteger(perDecision) || perDecision < 1) throw new Error("--per-decision must be a positive whole number");
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const messages = loadGroupingMessages(source.db);
    const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
    const options = { extractTickets: (t: string) => extractor.extractWorkItemIds(t) };
    const clustered = groupMessages(messages, { ...options, split: false });
    const placed = groupMessages(messages, options);
    const targets = drawTargets(clustered, placed, new Map(messages.map((m) => [m.key, { at: m.at, channelId: m.channelId }])), perDecision);
    const dir = prepareOutDir(root, LINKING_DIR);
    writePrivateFile(dir, "targets.json", JSON.stringify({ pairs: targets.map(({ a, b }) => ({ a, b })) }, null, 2) + "\n");
    writePrivateFile(dir, "targets-why.json", JSON.stringify(targets, null, 2) + "\n");
    const counts = targets.reduce<Record<string, number>>((acc, t) => ((acc[t.decision] = (acc[t.decision] ?? 0) + 1), acc), {});
    console.log(`Wrote ${targets.length} pairs (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")})`);
    console.log("Label them: npm run eval:pairs -- --only targets.json · then: npm run eval:targets -- --report labels.json");
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("targets.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`eval:targets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
