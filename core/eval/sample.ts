#!/usr/bin/env node
// core/eval/sample.ts — Draw a stratified sample of real messages from workstream.db into the eval set
//
// Usage: npm run eval:sample -- [--per-status 30] [--db workstream.db] [--seed 42]
// Stratifies on the status the live classifier assigned, so rare classes (blocked, decision)
// are represented. Appends to an existing dataset without touching labeled items.

import BetterSqlite3 from "better-sqlite3";
import { resolve } from "node:path";
import { findProjectRoot } from "../config.js";
import type { StatusCategory } from "../types.js";
import { STATUSES, defaultDatasetPath, loadDataset, saveDataset, type EvalItem } from "./dataset.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Deterministic PRNG so a sample can be reproduced. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: string;
  raw_text: string;
  status: StatusCategory;
  confidence: number;
  targeted_at_operator: number;
  timestamp: string;
  sender_name: string | null;
  is_bot: number | null;
  bot_type: string | null;
  channel_name: string | null;
}

function senderType(row: Row): string {
  if (row.bot_type === "notification") return "notification";
  if (row.is_bot === 1) return "agent";
  if (row.is_bot === 0) return "human";
  return "unknown";
}

function main(): void {
  const root = findProjectRoot();
  const perStatus = Number(arg("per-status", "30"));
  const dbPath = resolve(root, arg("db", "workstream.db"));
  const outPath = arg("out", defaultDatasetPath(root));
  const random = mulberry32(Number(arg("seed", "42")));

  const db = new BetterSqlite3(dbPath, { readonly: true });
  // One row per distinct message text — summaries fan out into several events with the same text.
  const rows = db.prepare(`
    SELECT e.id, e.raw_text, e.status, e.confidence, e.targeted_at_operator, e.timestamp,
           a.name AS sender_name, a.is_bot, a.bot_type, t.channel_name
    FROM events e
    LEFT JOIN agents a ON a.id = e.agent_id
    LEFT JOIN threads t ON t.id = e.thread_id
    WHERE length(trim(e.raw_text)) > 0
    GROUP BY e.raw_text
  `).all() as Row[];
  db.close();

  const existing = loadDataset(outPath);
  const seen = new Set(existing.map((i) => i.message));
  const added: EvalItem[] = [];

  for (const status of STATUSES) {
    const pool = rows.filter((r) => r.status === status && !seen.has(r.raw_text));
    // Fisher–Yates, then take the first N.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const r of pool.slice(0, perStatus)) {
      added.push({
        id: r.id,
        message: r.raw_text,
        senderName: r.sender_name ?? "unknown",
        senderType: senderType(r),
        channelName: r.channel_name ?? "",
        timestamp: r.timestamp,
        production: {
          status: r.status,
          confidence: r.confidence,
          targetedAtOperator: r.targeted_at_operator === 1,
        },
      });
    }
    console.log(`${status.padEnd(18)} pool ${String(pool.length).padStart(5)}  sampled ${Math.min(perStatus, pool.length)}`);
  }

  saveDataset(outPath, [...existing, ...added]);
  console.log(`\nAdded ${added.length} items → ${outPath} (${existing.length + added.length} total)`);
  console.log("Next: npm run eval:label");
}

main();
