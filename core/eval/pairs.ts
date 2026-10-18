#!/usr/bin/env node
// core/eval/pairs.ts — Keyboard-driven labeler for message grouping: is this pair the same piece of work?
//
// Usage: npm run eval:pairs -- [--grouping current,relink] [--per-stratum 10] [--seed 42] [--db workstream.db]
// Draws pairs of messages stratified to catch over-merges and splits (core/eval/linking-sample.ts) from the groupings
// named (by default the current one, and the re-link proposal when npm run relink has written it), skipping pairs
// already labeled, and asks about each (labels are keyed by the message's platform identity, see linking-labels.ts):
//   s  same work      d  different work      1 / 2  mark message A / B "not work" (again to clear)
//   u  unsure, skip   n  add note            q  save & quit
// Each message shows its sender, channel, time, its own lines and a few messages around it in its thread. Which item
// each grouping put it in isn't shown, so the verdict isn't steered by it. The database is read from a private
// read-only copy; labels go to eval-data/linking/labels.json and are saved after every label.

import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { loadItemContext, type ContextMessage } from "./context.js";
import {
  loadGroupings,
  loadMessageIndex,
  loadSenderNames,
  openSource,
  parseFlags,
  parseGroupingNames,
  projectRoot,
  relinkItemsPath,
  type Observation,
} from "./linking-data.js";
import { loadLabels, pairKey, saveLabels, setPairLabel, toggleNotWork } from "./linking-labels.js";
import { buildQueue } from "./linking-sample.js";

if (!process.stdin.isTTY) {
  console.error("eval:pairs needs an interactive terminal");
  process.exit(1);
}

function setup() {
  const flags = parseFlags(process.argv.slice(2), ["grouping", "per-stratum", "seed", "db"] as const);
  const root = projectRoot();
  const names = parseGroupingNames(flags.grouping ?? (existsSync(relinkItemsPath(root)) ? "current,relink" : "current"));
  const perStratum = Number(flags["per-stratum"] ?? "10");
  const seed = Number(flags.seed ?? "42");
  if (!Number.isInteger(perStratum) || perStratum < 1) throw new Error("--per-stratum must be a positive whole number");
  if (!Number.isInteger(seed)) throw new Error("--seed must be a whole number");

  const labels = loadLabels(root);
  const source = openSource(resolve(flags.db ?? resolve(root, "workstream.db")));
  try {
    const index = loadMessageIndex(source.db);
    const { observations } = index;
    const { groupings } = loadGroupings(names, root, source.db, index);
    const queue = buildQueue(observations, groupings, {
      perStratum,
      seed,
      labeled: new Set(labels.pairs.map((p) => pairKey(p.a, p.b))),
      senderNames: loadSenderNames(source.db),
    });
    return { root, labels, source, queue, byId: new Map(observations.map((o) => [o.id, o])) };
  } catch (err) {
    source.close();
    throw err;
  }
}

let state: ReturnType<typeof setup>;
try {
  state = setup();
} catch (err) {
  console.error(`eval:pairs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { root, labels, source, queue, byId } = state;

if (queue.length === 0) {
  source.close();
  console.log(labels.pairs.length ? "No unlabeled pairs left to draw. Try another --seed, or run: npm run eval:linking" : "No pairs to draw: the groupings place no messages.");
  process.exit(0);
}

let idx = 0;
let note: string | undefined;
/** Non-null while typing a note: keys go into the buffer instead of acting as commands. */
let noteDraft: string | null = null;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Slack text is untrusted: drop control characters so a message can't send terminal escape codes. */
function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function oneLine(m: ContextMessage, max = 160): string {
  const text = clean(m.text).replace(/\s+/g, " ").trim();
  return `${clean(m.sender)}: ${text.length > max ? text.slice(0, max) + "…" : text}`;
}

function gap(a: Observation, b: Observation): string {
  const minutes = Math.round(Math.abs(Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const isNotWork = (id: string) => labels.notWork.some((n) => n.message === id);

function renderMessage(tag: string, o: Observation | undefined, id: string): void {
  if (!o) {
    console.log(`${BOLD}── ${tag} ──${RESET} ${DIM}(message ${clean(id)} not found)${RESET}\n`);
    return;
  }
  const mark = isNotWork(o.id) ? `  ${BOLD}[not work]${RESET}` : "";
  console.log(`${BOLD}── ${tag} ──${RESET} ${clean(o.senderName)} in #${clean(o.channelName)}  ${o.timestamp}${mark}`);
  const ctx = loadItemContext(source.db, o.eventId, { before: 2, after: 1 });
  for (const m of ctx?.before ?? []) console.log(`${DIM}  before  ${oneLine(m)}${RESET}`);
  const text = clean(o.text);
  console.log(text.length > 1200 ? text.slice(0, 1200) + "\n…(truncated)" : text);
  for (const m of ctx?.after ?? []) console.log(`${DIM}  after   ${oneLine(m)}${RESET}`);
  console.log("");
}

function render(): void {
  const pair = queue[idx];
  const [a, b] = [byId.get(pair.a), byId.get(pair.b)];
  console.clear();
  const apart = a && b ? `  ·  ${a.threadId === b.threadId ? "same thread" : "different threads"}, ${gap(a, b)} apart` : "";
  console.log(`[${idx + 1}/${queue.length} · ${pair.stratum} · ${labels.pairs.length} pairs labeled]${apart}\n`);
  renderMessage("A", a, pair.a);
  renderMessage("B", b, pair.b);
  console.log("─".repeat(60));
  if (noteDraft !== null) {
    console.log(`  note: ${noteDraft}█`);
    console.log(`  ${DIM}enter save note · esc cancel${RESET}`);
    return;
  }
  if (note) console.log(`  note: ${note}`);
  console.log("  s same work · d different work · 1/2 A/B not work · u unsure, skip · n note · q quit");
}

function next(): void {
  idx++;
  note = undefined;
  if (idx >= queue.length) quit();
  render();
}

function quit(): never {
  saveLabels(root, labels);
  source.close();
  console.clear();
  console.log(`Saved ${labels.pairs.length} pair labels, ${labels.notWork.length} not-work marks → eval-data/linking/labels.json`);
  console.log("Next: npm run eval:linking");
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
render();

process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  if (key.ctrl && key.name === "c") quit();
  if (noteDraft !== null) return noteKey(str, key);
  const pair = queue[idx];
  if (key.name === "q") quit();
  if (key.name === "s" || key.name === "d") {
    setPairLabel(labels, { a: pair.a, b: pair.b, verdict: key.name === "s" ? "same" : "different", note, labeledAt: new Date().toISOString(), stratum: pair.stratum });
    saveLabels(root, labels);
    return next();
  }
  if (str === "1" || str === "2") {
    toggleNotWork(labels, str === "1" ? pair.a : pair.b);
    saveLabels(root, labels);
    return render();
  }
  if (key.name === "u") return next();
  if (key.name === "n") { noteDraft = note ?? ""; return render(); }
});
