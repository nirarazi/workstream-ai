#!/usr/bin/env node
// core/eval/label.ts — Keyboard-driven labeler for the eval set
//
// Usage: npm run eval:label
// Shows each unlabeled message with the live classifier's answer pre-selected.
//   1-5   set status          t     toggle "belongs in my inbox"
//   enter accept & next      s     skip        n  add note       q  save & quit
// Progress is saved after every label.

import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { findProjectRoot } from "../config.js";
import type { StatusCategory } from "../types.js";
import { STATUSES, defaultDatasetPath, loadDataset, saveDataset } from "./dataset.js";

const path = process.argv[2] ?? defaultDatasetPath(findProjectRoot());
const items = loadDataset(path);
const queue = items.filter((i) => !i.label);

if (!process.stdin.isTTY) {
  console.error("eval:label needs an interactive terminal");
  process.exit(1);
}
if (queue.length === 0) {
  console.log(items.length ? "Everything is labeled. Run: npm run eval:run" : "No dataset yet. Run: npm run eval:sample");
  process.exit(0);
}

let idx = 0;
let status: StatusCategory;
let targeted: boolean;
let note: string | undefined;

function load(): void {
  const item = queue[idx];
  status = item.production.status;
  targeted = item.production.targetedAtOperator;
  note = undefined;
}

function render(): void {
  const item = queue[idx];
  const done = items.length - queue.length + idx;
  console.clear();
  console.log(`[${done}/${items.length} labeled]  ${item.senderName} (${item.senderType}) in #${item.channelName}  ${item.timestamp}\n`);
  console.log(item.message.length > 2500 ? item.message.slice(0, 2500) + "\n…(truncated)" : item.message);
  console.log("\n" + "─".repeat(60));
  console.log(`live classifier: ${item.production.status} (${item.production.confidence.toFixed(2)}), inbox=${item.production.targetedAtOperator}\n`);
  STATUSES.forEach((s, i) => console.log(`  ${i + 1}  ${s === status ? "●" : "○"} ${s}`));
  console.log(`\n  t  belongs in my inbox: ${targeted ? "YES" : "no"}`);
  if (note) console.log(`  note: ${note}`);
  console.log("\n  enter accept · s skip · n note · q quit");
}

function next(): void {
  idx++;
  if (idx >= queue.length) quit();
  load();
  render();
}

function quit(): never {
  saveDataset(path, items);
  console.clear();
  console.log(`Saved → ${path}`);
  process.exit(0);
}

async function askNote(): Promise<void> {
  process.stdin.setRawMode(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  note = (await rl.question("note: ")).trim() || undefined;
  rl.close();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render();
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
load();
render();

process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  if (key.ctrl && key.name === "c") quit();
  if (key.name === "q") quit();
  if (key.name === "return") {
    queue[idx].label = { status, targetedAtOperator: targeted, labeledAt: new Date().toISOString(), note };
    saveDataset(path, items);
    next();
    return;
  }
  if (key.name === "s") return next();
  if (key.name === "t") { targeted = !targeted; return render(); }
  if (key.name === "n") { void askNote(); return; }
  const n = Number(str);
  if (n >= 1 && n <= STATUSES.length) {
    status = STATUSES[n - 1];
    // Blocks always belong in the inbox (operator is the backstop) — default it on.
    if (status === "blocked_on_human" || status === "needs_decision") targeted = true;
    render();
  }
});
