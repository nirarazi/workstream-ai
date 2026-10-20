#!/usr/bin/env node
// core/eval/inbox-label.ts — Keyboard-driven labeler for the inbox comparison: does this ask need you now?
//
// Usage: npm run eval:inbox-label -- [--db workstream.db]
// Asks about each disagreement npm run eval:inbox-diff found (eval-data/inbox-diff/queue.json): an ask only one of
// Needs me now and Needs me under v2 would show, or one more entry one shows beside an ask both show. Which side shows
// it isn't said, nor hinted by the order (the queue is ordered by a hash of each entry) or by the ask's classification,
// so the answer isn't steered by either. Each shows the ask (sender, channel, time, its text, a few messages before it
// in its thread) and, where there is one, the later message that is why the other side doesn't show it:
//   y  yes, it needs me now (beyond what "Later" asks)      n  no      u  unsure, skip      q  save & quit
// Answers go to eval-data/inbox-diff/labels.json, saved after each one and merged with whatever another session saved
// meanwhile (the newer answer to an entry wins); npm run eval:inbox-diff scores both sides on them. The database is
// read from a private read-only copy. SIGHUP, SIGINT or SIGTERM saves, restores the terminal and removes the copy.

import { readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { join, resolve } from "node:path";
import { openReadOnly, prepareOutDir, writePrivateFile, type ReadOnlyCopy } from "../graph/relink.js";
import { loadItemContext, type ContextMessage } from "./context.js";
import type { InboxLabel, QueueEntry } from "./inbox-diff.js";
import { onStopSignals, parseFlags, projectRoot } from "./linking-data.js";
import { projectFile } from "./linking-labels.js";
import { clean, quoted } from "./terminal.js";

const OUT_DIR = join("eval-data", "inbox-diff");
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

if (!process.stdin.isTTY) {
  console.error("eval:inbox-label needs an interactive terminal");
  process.exit(1);
}

/** Set as setup opens it, so a signal at any point cleans up what exists */
let openSource: ReadOnlyCopy | undefined;
/** This session's answers: only these are saved, so another session's newer answers aren't overwritten */
const mine = new Map<string, InboxLabel>();
let root = "";
let outDir = "";

/** The answers in the file as it is now */
function readLabels(): InboxLabel[] {
  const path = projectFile(root, OUT_DIR, "labels.json");
  return path ? (JSON.parse(readFileSync(path, "utf8")) as { labels: InboxLabel[] }).labels : [];
}

/** Merges this session's answers into the file as it is now, the newer answer to an entry winning */
function save(): void {
  if (mine.size === 0 || !outDir) return;
  const merged = new Map(readLabels().map((l) => [l.id, l]));
  for (const [id, l] of mine) {
    const theirs = merged.get(id);
    if (!theirs || theirs.labeledAt <= l.labeledAt) merged.set(id, l);
  }
  writePrivateFile(outDir, "labels.json", JSON.stringify({ version: 1, labels: [...merged.values()] }, null, 2) + "\n");
}

/** Saves, restores the terminal and removes the database copy */
function stop(): void {
  try {
    save();
  } finally {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } finally {
      const copy = openSource;
      openSource = undefined;
      copy?.close();
    }
  }
}

/** Ends the run on an error: restores the terminal, removes the copy, and says what went wrong */
function fail(err: unknown): never {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } finally {
    const copy = openSource;
    openSource = undefined;
    copy?.close();
  }
  console.error(`eval:inbox-label: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

onStopSignals(stop);

let entries: QueueEntry[] = [];
let queue: QueueEntry[] = [];
let source: ReadOnlyCopy;
try {
  root = projectRoot();
  const flags = parseFlags(process.argv.slice(2), ["db"] as const);
  const queuePath = projectFile(root, OUT_DIR, "queue.json");
  if (!queuePath) throw new Error("no queue yet. Run npm run eval:inbox-diff first");
  entries = (JSON.parse(readFileSync(queuePath, "utf8")) as { entries: QueueEntry[] }).entries;
  outDir = prepareOutDir(root, OUT_DIR);
  const answered = new Set(readLabels().map((l) => l.id));
  queue = entries.filter((e) => !answered.has(e.id));
  if (queue.length === 0) {
    console.log(entries.length === 0
      ? "Nothing to judge: the two inboxes agree. Next: npm run eval:inbox-diff"
      : `Nothing left to judge: all ${entries.length} disagreements are answered. Next: npm run eval:inbox-diff`);
    process.exit(0);
  }
  source = openSource = openReadOnly(resolve(flags.db ?? "workstream.db"));
} catch (err) {
  fail(err);
}

let idx = 0;
const eventRow = source.db.prepare(`
  SELECT e.raw_text, e.timestamp, COALESCE(a.name, 'unknown') AS sender, COALESCE(t.channel_name, '') AS channel
  FROM events e LEFT JOIN agents a ON a.id = e.agent_id LEFT JOIN threads t ON t.id = e.thread_id WHERE e.id = ?
`);

function oneLine(m: ContextMessage, max = 160): string {
  const text = clean(m.text).replace(/\s+/g, " ").trim();
  return `${clean(m.sender)}: ${text.length > max ? text.slice(0, max) + "…" : text}`;
}

/** A message, its header on one line (a name with a line break can't add a line that passes for the labeler's own) */
function renderMessage(tag: string, eventId: string, around: boolean): void {
  const e = eventRow.get(eventId) as { raw_text: string | null; timestamp: string; sender: string; channel: string } | undefined;
  if (!e) {
    console.log(`${BOLD}── ${tag} ──${RESET} ${DIM}(message not found)${RESET}\n`);
    return;
  }
  const flat = (s: string) => clean(s).replace(/\s+/g, " ").trim();
  console.log(`${BOLD}── ${tag} ──${RESET} ${flat(e.sender)} in #${flat(e.channel)}  ${flat(e.timestamp)}`);
  const ctx = around ? loadItemContext(source.db, eventId, { before: 2, after: 0 }) : null;
  for (const m of ctx?.before ?? []) console.log(`${DIM}  before  ${oneLine(m)}${RESET}`);
  const text = e.raw_text ?? "";
  console.log(quoted(text.length > 1200 ? text.slice(0, 1200) + "\n…(truncated)" : text));
  console.log("");
}

function render(): void {
  const q = queue[idx];
  console.clear();
  console.log(`[${idx + 1}/${queue.length} · ${mine.size} answered this session]\n`);
  renderMessage("The ask", q.ask, true);
  if (q.later) renderMessage("Later", q.later, false);
  console.log("─".repeat(60));
  console.log("  Does the ask need you now, beyond what \"Later\" asks?   y yes · n no · u unsure, skip · q quit");
  console.log(`  ${DIM}Yes: it's still waiting on you, for something of its own.${RESET}`);
  console.log(`  ${DIM}No: it's done, someone else has it, it never needed you, "Later" settled it, or "Later" already asks you the same thing.${RESET}`);
}

function next(): void {
  idx++;
  if (idx >= queue.length) quit();
  render();
}

function quit(): never {
  stop();
  console.clear();
  console.log(`Saved ${mine.size} answers → eval-data/inbox-diff/labels.json`);
  console.log("Next: npm run eval:inbox-diff");
  process.exit(0);
}

function onKey(key: { name?: string; ctrl?: boolean }): void {
  if ((key.ctrl && key.name === "c") || key.name === "q") quit();
  if (key.name === "y" || key.name === "n") {
    const q = queue[idx];
    mine.set(q.id, { id: q.id, needed: key.name === "y" ? "yes" : "no", labeledAt: new Date().toISOString() });
    save();
    return next();
  }
  if (key.name === "u") return next();
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
render();
process.stdin.on("keypress", (_str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  try {
    onKey(key);
  } catch (err) {
    // A failed save: the answer just given isn't in the file
    fail(err);
  }
});
