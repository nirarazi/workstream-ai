#!/usr/bin/env node
// core/graph/relink-cli.ts — Re-link dry run over a workstream.db, read-only
//
// Usage: npm run relink -- [--db ./workstream.db] [--prefixes OPS-,ENG-] [--rules subject-rules.yaml]
// Opens the database read-only, replays every event through the resolver with no model, and writes the proposal to
// eval-data/relink/ under the project (gitignored): summary.json, items.json, merges.json, decisions.jsonl and
// subject-rule-candidates.json. They hold ids, keys and current item titles, never message text.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectRoot } from "../config.js";
import { loadSubjectRules, runRelink } from "./relink.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function main(): void {
  // The project the command runs in (its eval-data/), else this checkout's
  const root = existsSync(resolve("config", "default.yaml")) ? process.cwd() : findProjectRoot();
  const dbPath = resolve(arg("db") ?? "workstream.db");
  const prefixes = arg("prefixes")?.split(",").map((p) => p.trim()).filter(Boolean);
  const rulesPath = arg("rules");

  const run = runRelink({ dbPath, root, prefixes, subjectRules: rulesPath ? loadSubjectRules(rulesPath) : undefined });
  const s = run.summary;
  console.log(`Replayed ${s.events} events (read-only)`);
  console.log(`Items: ${s.before.items} now → ${s.after.items} proposed`);
  console.log(`One-message items: ${s.before.singleMessageItems} → ${s.after.singleMessageItems}`);
  console.log(`Items per ticket (max): ${s.itemsPerTicket.before.max} → ${s.itemsPerTicket.after.max}`);
  console.log(`Reports excluded: ${s.reports.messages}; activity, not items: ${s.activityNotItem}; would ask the model: ${s.needsModel}`);
  console.log(`\nReports written to ${run.outDir}`);
}

try {
  main();
} catch (err) {
  console.error(`relink: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
