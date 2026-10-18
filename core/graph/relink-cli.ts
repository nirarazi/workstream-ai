#!/usr/bin/env node
// core/graph/relink-cli.ts — Re-link dry run over a workstream.db, read-only
//
// Usage: npm run relink -- [--db ./workstream.db] [--prefixes OPS-,ENG-] [--rules subject-rules.yaml]
// Copies the database to a private temporary directory, opens the copy read-only, replays every event through the
// resolver with no model, and writes the proposal to eval-data/relink/ under the project (gitignored): summary.json,
// items.json, merges.json, decisions.jsonl and subject-rule-candidates.json. They hold ids, keys, current item titles
// and agents' lane tags, but no raw message text.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectRoot } from "../config.js";
import { loadSubjectRules, parseRelinkArgs, RelinkStopped, runRelink } from "./relink.js";

/** Exit codes for a run stopped by a signal, by convention 128 + the signal's number */
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

async function main(): Promise<void> {
  // A signal stops the run at its next step: the copy is removed and no reports are written. A second one exits at
  // once (the copy is still removed at exit).
  const stop = new AbortController();
  for (const name of Object.keys(SIGNAL_EXIT)) {
    process.on(name, () => {
      if (stop.signal.aborted) process.exit(SIGNAL_EXIT[name]);
      stop.abort(name);
    });
  }

  const args = parseRelinkArgs(process.argv.slice(2));
  // The project the command runs in (its eval-data/), else this checkout's
  const root = existsSync(resolve("config", "default.yaml")) ? process.cwd() : findProjectRoot();
  const dbPath = resolve(args.db ?? "workstream.db");

  let run;
  try {
    run = await runRelink({
      dbPath,
      root,
      prefixes: args.prefixes,
      subjectRules: args.rules ? loadSubjectRules(args.rules) : undefined,
      signal: stop.signal,
    });
  } catch (err) {
    if (err instanceof RelinkStopped) {
      console.error(`relink: ${err.message}`);
      process.exit(SIGNAL_EXIT[String(stop.signal.reason)] ?? 1);
    }
    throw err;
  }
  const s = run.summary;
  console.log(`Replayed ${s.events} events (read-only copy)`);
  console.log(`Items: ${s.before.items} now → ${s.after.items} proposed`);
  console.log(`One-message items: ${s.before.singleMessageItems} → ${s.after.singleMessageItems}`);
  console.log(`Items per ticket (max): ${s.itemsPerTicket.before.max} → ${s.itemsPerTicket.after.max}`);
  console.log(`Reports excluded: ${s.reports.messages}; activity, not items: ${s.activityNotItem}; would ask the model: ${s.needsModel}`);
  console.log(`\nReports written to ${run.outDir}`);
}

main().catch((err: unknown) => {
  console.error(`relink: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
