#!/usr/bin/env node
// core/eval/constraint-labels.ts — The operator's corrections in the app, as grouping labels
//
// Usage: npm run eval:constraint-labels -- [--db workstream.db]
// Every merge, link, unlink and "noise" the operator makes in the app is kept as a constraint (core/graph/constraints.ts).
// Each is also a verdict on how messages group, so this writes the live ones (not suspended) as a label set,
// eval-data/linking/labels.operator.json, which npm run eval:linking -- --labels labels.operator.json scores against.
// So the evaluation grows as the operator uses the app, with no separate labelling:
//   must_link → same work · cannot_link → different work · not_an_item → not work
//   pins to one key → same work, for each observation and the next one pinned to that key
// Aliases name keys, not messages, so they give no pairs. Labels are keyed like the operator's (messageKey).

import { resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openReadOnly, type ReadOnlyCopy } from "../graph/relink.js";
import type { Constraint } from "../graph/constraints.js";
import { messageKey, onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { emptyLabels, saveLabels, setNotWork, setPairLabel, type LinkingLabels } from "./linking-labels.js";

export const OPERATOR_LABELS_FILE = "labels.operator.json";

/**
 * Pure. Live, unsuspended constraints as labels; `messageOf` maps an observation's dedupeKey to its message key (an
 * observation it can't map, from another platform or an older copy, is skipped).
 */
export function labelsFromConstraints(constraints: readonly Constraint[], messageOf: (dedupeKey: string) => string | null): LinkingLabels {
  const labels = emptyLabels();
  const applied = constraints.filter((c) => !c.retiredAt && !c.suspendedAt);
  const pair = (c: Constraint, a: string, b: string, verdict: "same" | "different") => {
    const [x, y] = [messageOf(a), messageOf(b)];
    if (x && y && x !== y) setPairLabel(labels, { a: x, b: y, verdict, labeledAt: c.createdAt, stratum: `operator:${c.kind}`, note: c.origin ?? undefined });
  };
  for (const c of applied) {
    if (c.kind === "must_link" && c.b) pair(c, c.a, c.b, "same");
    else if (c.kind === "cannot_link" && c.b) pair(c, c.a, c.b, "different");
    else if (c.kind === "not_an_item") {
      const m = messageOf(c.a);
      if (m) setNotWork(labels, m, true, c.createdAt, c.origin ?? undefined);
    }
  }
  const pinned = new Map<string, Constraint[]>();
  for (const c of applied) if (c.kind === "pin" && c.b) pinned.set(c.b, [...(pinned.get(c.b) ?? []), c]);
  for (const pins of pinned.values()) {
    for (let i = 1; i < pins.length; i++) pair(pins[i], pins[i - 1].a, pins[i].a, "same");
  }
  return labels;
}

function readConstraints(db: BetterSqlite3.Database): Constraint[] {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'constraints'").get();
  if (!hasTable) return [];
  return (db.prepare("SELECT * FROM constraints WHERE retired_at IS NULL ORDER BY created_at, id").all() as Array<Record<string, string | null>>)
    .map((r) => ({
      id: r.id!, kind: r.kind as Constraint["kind"], a: r.a!, b: r.b, decidedBy: r.decided_by!, origin: r.origin,
      createdAt: r.created_at!, retiredAt: r.retired_at, suspendedAt: r.suspended_at, supersededBy: r.superseded_by,
    }));
}

let openSource: ReadOnlyCopy | undefined;

function main(): void {
  const flags = parseFlags(process.argv.slice(2), ["db"] as const);
  const root = projectRoot();
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  try {
    const constraints = readConstraints(source.db);
    const rows = source.db.prepare("SELECT dedupe_key, platform, container_id, message_id FROM observations").all() as Array<{
      dedupe_key: string; platform: string; container_id: string; message_id: string;
    }>;
    const byKey = new Map(rows.map((r) => [r.dedupe_key, messageKey(r.platform, r.container_id, r.message_id)]));
    const labels = labelsFromConstraints(constraints, (k) => byKey.get(k) ?? null);
    const path = saveLabels(root, labels, OPERATOR_LABELS_FILE);
    console.log(`${constraints.length} live constraints → ${labels.pairs.length} pairs, ${labels.notWork.length} not-work marks → ${path}`);
    console.log(`Next: npm run eval:linking -- --labels ${OPERATOR_LABELS_FILE}`);
  } finally {
    openSource = undefined;
    source.close();
  }
}

if (process.argv[1]?.endsWith("constraint-labels.ts")) {
  onStopSignals(() => {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  });
  try {
    main();
  } catch (err) {
    console.error(`eval:constraint-labels: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
