#!/usr/bin/env node
// core/grouping/blocked-cli.ts — What's blocked on the operator, most important first, over a read-only copy
//
// Usage: npm run report:blocked -- [--db workstream.db] [--operator "Dana,U0DANA"]
// The operator's first question: what am I blocking? From the grouping shadow mode stored (never regrouping), it takes
// the asks Needs me by case holds (core/grouping/inbox.ts) and ranks them as the Overview does (core/grouping/rank.ts):
// by who each holds up, then how often it was asked, then how long it has waited, with the reason for each. It prints
// the ranking and writes it, with a few words of each ask, to eval-data/blocked/report.md (real messages, so the file
// is private and stays in eval-data/). --operator names the operator as for npm run eval:inbox-diff. Nothing is
// written to the database and no model is called.

import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { operatorNames } from "../operator-names.js";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { onStopSignals, parseFlags, projectRoot } from "../eval/linking-data.js";
import { excerpt } from "../eval/inbox-diff.js";
import { clean } from "../eval/terminal.js";
import { loadOverviewInput, streamLabel } from "./overview.js";
import { rankReason } from "./rank.js";

let openSource: ReadOnlyCopy | undefined;

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["db", "operator"] as const);
  const root = projectRoot();
  const config = loadConfig();
  const given = (flags.operator ?? config.operator?.name ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const names = [...new Set(given.flatMap((n) => operatorNames(undefined, n)))];
  if (names.length === 0) console.log("No operator name (config operator.name or --operator): who's blocked on you can't be told");
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const now = new Date().toISOString();
    const input = loadOverviewInput(source.db, { operatorNames: names, handoff: config.inbox?.handoffMinConfidence ?? 0.6, now });
    if (!input) {
      console.log("No stored grouping yet: the engine stores one in shadow mode after a poll");
      return;
    }
    const channelNames = new Map(input.grouping.messages.filter((m) => m.channelId && m.channelName).map((m) => [m.channelId!, m.channelName]));
    const cases = new Map(input.grouping.cases.map((c) => [c.id, c]));
    const lines = ["# Blocked on you", "", `Read ${now}, from the grouping stored ${input.grouping.computedAt}. ${input.ranked.length} asks.`, ""];
    console.log(`${input.ranked.length} asks waiting on you, most important first:`);
    input.ranked.forEach((r, i) => {
      const c = cases.get(r.entry.caseId);
      const where = c ? streamLabel(c.stream, channelNames) : "reports only";
      const reason = rankReason(r, now, input.actorName);
      console.log(`${String(i + 1).padStart(3)}. ${clean(reason).slice(0, 160)}  [${clean(where).slice(0, 40)}]`);
      lines.push(`${i + 1}. **${excerpt(where, 60)}**: ${excerpt(r.entry.ask.text)}`, `   - ${excerpt(reason, 200)}; from ${excerpt(r.entry.ask.senderName, 60)}, case ${r.entry.caseId}`);
    });
    const dir = prepareOutDir(root, "eval-data/blocked");
    console.log(`Wrote ${writePrivateFile(dir, "report.md", lines.join("\n") + "\n")}`);
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("blocked-cli.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`report:blocked: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
