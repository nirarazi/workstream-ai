#!/usr/bin/env node
// core/eval/label.ts — Keyboard-driven labeler for the eval set
//
// Usage: npm run eval:label [-- --disputed] [path]
// Walks every item without a human label: unlabeled ones pre-filled with the live classifier's
// answer, draft-labeled ones pre-filled with the draft. --disputed limits the queue to drafts that
// disagree with the live classifier or are marked ambiguous.
//   1-5   set status          t     toggle "belongs in my inbox"
//   enter accept & next      s     skip        n  add note       q  save & quit
// Each item shows its work item and the surrounding thread messages from workstream.db.
// Progress is saved after every label.

import BetterSqlite3 from "better-sqlite3";
import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { findProjectRoot } from "../config.js";
import type { StatusCategory } from "../types.js";
import { loadItemContext, type ContextMessage } from "./context.js";
import { STATUSES, defaultDatasetPath, loadDataset, saveDataset } from "./dataset.js";

const args = process.argv.slice(2);
const disputedOnly = args.includes("--disputed");
const root = findProjectRoot();
const path = args.find((a) => !a.startsWith("--")) ?? defaultDatasetPath(root);
const dbPath = resolve(root, "workstream.db");
const db = existsSync(dbPath) ? new BetterSqlite3(dbPath, { readonly: true }) : null;
const items = loadDataset(path);
const isDisputed = (i: (typeof items)[number]) =>
  i.label?.source === "draft" && (i.label.status !== i.production.status || /ambiguous/.test(i.label.note ?? ""));
const queue = items.filter((i) => (disputedOnly ? isDisputed(i) : !i.label || i.label.source === "draft"));

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
/** Non-null while typing a note: keys go into the buffer instead of acting as commands. */
let noteDraft: string | null = null;

function load(): void {
  const item = queue[idx];
  status = item.label?.status ?? item.production.status;
  targeted = item.label?.targetedAtOperator ?? item.production.targetedAtOperator;
  // Draft notes are shown on the draft line; the note field holds only the operator's own words.
  note = item.label?.source === "draft" ? undefined : item.label?.note;
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function oneLine(m: ContextMessage, max = 220): string {
  const text = m.text.replace(/\s+/g, " ").trim();
  return `${m.sender}: ${text.length > max ? text.slice(0, max) + "…" : text}`;
}

/** Prints the work item and earlier thread messages; returns the messages that came after. */
function renderContext(eventId: string): ContextMessage[] {
  const ctx = db ? loadItemContext(db, eventId) : null;
  if (!ctx) {
    console.log(`${DIM}(no thread context — workstream.db not found or event missing)${RESET}\n`);
    return [];
  }
  if (ctx.workItems.length === 0) console.log(`${BOLD}work item:${RESET} none linked`);
  for (const w of ctx.workItems) {
    const meta = [w.status, w.assignee && `assignee ${w.assignee}`].filter(Boolean).join(" · ");
    console.log(`${BOLD}work item:${RESET} ${w.id.startsWith("thread:") ? "(no ticket)" : w.id}  ${w.title}${meta ? `  ${DIM}[${meta}]${RESET}` : ""}`);
    if (w.url) console.log(`           ${DIM}${w.url}${RESET}`);
  }
  console.log("");
  if (ctx.root) console.log(`${DIM}  thread start  ${oneLine(ctx.root)}\n  …${RESET}`);
  for (const m of ctx.before) console.log(`${DIM}  before  ${oneLine(m)}${RESET}`);
  console.log(`${BOLD}  ▶ this message${RESET}`);
  return ctx.after;
}

function render(): void {
  const item = queue[idx];
  const done = items.filter((i) => i.label?.source === "human" || (i.label && !i.label.source)).length;
  console.clear();
  console.log(`[${idx + 1}/${queue.length} in queue · ${done}/${items.length} human-labeled]  ${item.senderName} (${item.senderType}) in #${item.channelName}  ${item.timestamp}\n`);
  const after = renderContext(item.id);
  console.log(item.message.length > 2500 ? item.message.slice(0, 2500) + "\n…(truncated)" : item.message);
  for (const m of after) console.log(`${DIM}  after   ${oneLine(m)}${RESET}`);
  console.log("\n" + "─".repeat(60));
  console.log(`live classifier: ${item.production.status} (${item.production.confidence.toFixed(2)}), inbox=${item.production.targetedAtOperator}`);
  if (item.label?.source === "draft") {
    console.log(`draft label:     ${item.label.status}, inbox=${item.label.targetedAtOperator}${item.label.note ? `  (${item.label.note})` : ""}`);
  }
  console.log("");
  STATUSES.forEach((s, i) => console.log(`  ${i + 1}  ${s === status ? "●" : "○"} ${s}`));
  console.log(`\n  t  belongs in my inbox: ${targeted ? "YES" : "no"}`);
  if (noteDraft !== null) {
    console.log(`\n  note: ${noteDraft}█`);
    console.log(`  ${DIM}enter save note · esc cancel${RESET}`);
    return;
  }
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

/** Keystrokes while typing a note. Stays in raw mode so command keys can't leak through. */
function noteKey(str: string | undefined, key: { name?: string; ctrl?: boolean }): void {
  if (key.name === "return" || key.name === "enter") {
    note = noteDraft!.trim() || undefined;
    noteDraft = null;
  } else if (key.name === "escape") {
    noteDraft = null;
  } else if (key.name === "backspace") {
    noteDraft = noteDraft!.slice(0, -1);
  } else if (str && !key.ctrl && str >= " ") {
    noteDraft += str;
  }
  render();
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
load();
render();

process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  if (key.ctrl && key.name === "c") quit();
  if (noteDraft !== null) return noteKey(str, key);
  if (key.name === "q") quit();
  if (key.name === "return") {
    queue[idx].label = { status, targetedAtOperator: targeted, labeledAt: new Date().toISOString(), source: "human", note };
    saveDataset(path, items);
    next();
    return;
  }
  if (key.name === "s") return next();
  if (key.name === "t") { targeted = !targeted; return render(); }
  if (key.name === "n") { noteDraft = note ?? ""; return render(); }
  const n = Number(str);
  if (n >= 1 && n <= STATUSES.length) {
    status = STATUSES[n - 1];
    // Blocks always belong in the inbox (operator is the backstop) — default it on.
    if (status === "blocked_on_human" || status === "needs_decision") targeted = true;
    render();
  }
});
