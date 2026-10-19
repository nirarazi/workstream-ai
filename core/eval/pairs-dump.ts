#!/usr/bin/env node
// core/eval/pairs-dump.ts — Write the labeling queue, with each message's text and context, to a private file
//
// Usage: npm run eval:pairs-dump -- [--grouping current,relink] [--per-stratum 50] [--seed 42] [--db workstream.db]
// Draws pairs as npm run eval:pairs does (same strata, same seed, same order), but writes them all at once to
// eval-data/linking/dump.json, for labeling in bulk by another labeler (a model, say) into its own labels file. Pairs
// the operator already labeled are kept, so the two label sets overlap and can be compared (npm run eval:agreement);
// the operator's verdicts are never written. Real message text: the file is private and stays in eval-data/.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { loadItemContext, type ContextMessage } from "./context.js";
import {
  loadGroupings,
  loadMessageIndex,
  loadSenderNames,
  onStopSignals,
  parseFlags,
  parseGroupingNames,
  projectRoot,
  relinkItemsPath,
  type Observation,
} from "./linking-data.js";
import { LINKING_DIR } from "./linking-labels.js";
import { buildQueue } from "./linking-sample.js";

const DUMP_FILE = "dump.json";
const MAX_TEXT = 1500;
const MAX_CONTEXT = 300;

let openSource: ReadOnlyCopy | undefined;

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) + " …(truncated)" : text);
const context = (m: ContextMessage) => ({ sender: m.sender, at: m.timestamp, text: cut(m.text, MAX_CONTEXT) });

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["grouping", "per-stratum", "seed", "db"] as const);
  const root = projectRoot();
  const names = parseGroupingNames(flags.grouping ?? (existsSync(relinkItemsPath(root)) ? "current,relink" : "current"));
  const perStratum = Number(flags["per-stratum"] ?? "50");
  const seed = Number(flags.seed ?? "42");
  if (!Number.isInteger(perStratum) || perStratum < 1) throw new Error("--per-stratum must be a positive whole number");
  if (!Number.isInteger(seed)) throw new Error("--seed must be a whole number");

  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const index = loadMessageIndex(source.db);
    const { groupings } = loadGroupings(names, root, source.db, index);
    const queue = buildQueue(index.observations, groupings, {
      perStratum,
      seed,
      labeled: new Set(),
      senderNames: loadSenderNames(source.db),
    });
    const byId = new Map(index.observations.map((o) => [o.id, o]));
    const message = (o: Observation | undefined) => {
      if (!o) return null;
      const ctx = loadItemContext(source.db, o.eventId, { before: 3, after: 2 });
      return {
        sender: o.senderName,
        channel: o.channelName,
        at: o.timestamp,
        threadId: o.threadId,
        text: cut(o.text, MAX_TEXT),
        before: (ctx?.before ?? []).map(context),
        after: (ctx?.after ?? []).map(context),
      };
    };
    const pairs = queue.map((c) => ({ a: c.a, b: c.b, stratum: c.stratum, A: message(byId.get(c.a)), B: message(byId.get(c.b)) }));
    const dir = prepareOutDir(root, LINKING_DIR);
    const path = writePrivateFile(dir, DUMP_FILE, JSON.stringify({ seed, perStratum, groupings: names, pairs }, null, 2) + "\n");
    console.log(`Wrote ${pairs.length} pairs → ${path}`);
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("pairs-dump.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`eval:pairs-dump: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
