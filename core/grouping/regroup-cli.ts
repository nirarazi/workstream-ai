#!/usr/bin/env node
// core/grouping/regroup-cli.ts — Dry run of the v2 grouping over a read-only copy of the database
//
// Usage: npm run regroup -- [--db workstream.db]
// Groups every message into cases and streams (core/grouping/), changes nothing, and writes what it found to
// eval-data/regroup/: cases.json (each case's messages, keys, stream, and why each message joined it) and
// summary.json. Real message keys, so the files are private and stay in eval-data/.

import { resolve } from "node:path";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { DefaultExtractor } from "../graph/extractors/default.js";
import { onStopSignals, parseFlags, projectRoot } from "../eval/linking-data.js";
import { groupMessages } from "./index.js";
import { loadGroupingMessages } from "./load.js";
import { casesFrom } from "./streams.js";

let openSource: ReadOnlyCopy | undefined;

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["db"] as const);
  const root = projectRoot();
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const messages = loadGroupingMessages(source.db);
    const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
    const started = Date.now();
    const placements = groupMessages(messages, { extractTickets: (t) => extractor.extractWorkItemIds(t) });
    const info = new Map(messages.map((m) => [m.key, { at: m.at, channelId: m.channelId }]));
    const { cases, streams } = casesFrom(placements, info);
    const kinds: Record<string, number> = {};
    for (const p of placements.values()) {
      const k = p.cluster ? "work" : p.reasons[0];
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const sizes = cases.map((c) => c.members.length).sort((a, b) => a - b);
    const summary = {
      messages: messages.length,
      kinds,
      cases: cases.length,
      singleCases: sizes.filter((n) => n === 1).length,
      medianCase: sizes[Math.floor(sizes.length / 2)] ?? 0,
      largestCase: sizes[sizes.length - 1] ?? 0,
      streams: streams.length,
      streamsByKind: streams.reduce<Record<string, number>>((acc, s) => {
        const kind = s.key.split(":")[0];
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {}),
      ms: Date.now() - started,
    };
    const dir = prepareOutDir(root, "eval-data/regroup");
    writePrivateFile(dir, "cases.json", JSON.stringify({ cases, streams }, null, 2) + "\n");
    const path = writePrivateFile(dir, "summary.json", JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Wrote ${dir}/cases.json and ${path}`);
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("regroup-cli.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`regroup: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
