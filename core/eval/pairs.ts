#!/usr/bin/env node
// core/eval/pairs.ts — Keyboard-driven labeler for message grouping: is this pair the same piece of work?
//
// Usage: npm run eval:pairs -- [--grouping current,relink] [--per-stratum 10] [--seed 42] [--db workstream.db] [--only escalate.json]
// Draws pairs of messages stratified to catch over-merges and splits (core/eval/linking-sample.ts) from the groupings
// named (by default the current one, and the re-link proposal when npm run relink has written it), skipping pairs
// already labeled, and asks about each (labels are keyed by the message's platform identity, see linking-labels.ts).
// --only asks about just the pairs listed in a file in eval-data/linking/ ({ "pairs": [{ "a", "b" }] }), such as the
// ones another labeler was unsure of, without showing its answers:
//   s  same work      d  different work      1 / 2  mark message A / B "not work" (again to clear)
//   a / b  mark message A / B "mixed": it moves several cases (again to clear)
//   u  unsure, skip   n  add note            q  save & quit
// A dimmed hint under the keys says what each verdict means. A note goes with the next verdict or mark. A
// skipped pair comes back once at the end of the session, and nothing is recorded for it, so a later session can draw
// it again.
// Each message shows its sender, channel, time, its own lines and a few messages around it in its thread. Which item
// each grouping put it in isn't shown, so the verdict isn't steered by it. The database is read from a private
// read-only copy; labels go to eval-data/linking/labels.json and are saved after every label, merged with whatever
// another session saved meanwhile. SIGHUP, SIGINT or SIGTERM saves, restores the terminal and removes the copy.

import { existsSync, readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { openReadOnly, type ReadOnlyCopy } from "../graph/relink.js";
import { loadItemContext, type ContextMessage } from "./context.js";
import {
  loadGroupings,
  loadMessageIndex,
  loadSenderNames,
  onStopSignals,
  parseFlags,
  parseGroupingNames,
  projectRoot,
  relinkItemsPath,
  type Observation,
} from "./linking-data.js";
import { LabelSession, LINKING_DIR, pairKey, projectFile } from "./linking-labels.js";
import { buildQueue, type Candidate } from "./linking-sample.js";
import { clean, quoted } from "./terminal.js";

if (!process.stdin.isTTY) {
  console.error("eval:pairs needs an interactive terminal");
  process.exit(1);
}

/** Set as setup opens them, so a signal at any point saves and cleans up what exists */
let openSession: LabelSession | undefined;
let openSource: ReadOnlyCopy | undefined;

/** Saves (merging with the file as it is now), restores the terminal and removes the database copy */
function stop(): void {
  try {
    openSession?.save();
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
  console.error(`eval:pairs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Before the copy is opened, so a signal during setup still removes it
onStopSignals(stop);

/** The pairs listed in a file in eval-data/linking/, in order (a file name, never a path) */
function loadEscalated(root: string, name: string): Candidate[] {
  if (!/^[a-z0-9-]{1,32}\.json$/.test(name)) throw new Error(`--only takes a file name in eval-data/linking/, like escalate.json`);
  const path = projectFile(root, LINKING_DIR, name);
  if (!path) throw new Error(`--only: eval-data/linking/${name} doesn't exist`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as { pairs?: unknown };
  if (!Array.isArray(data.pairs)) throw new Error("escalate.json: pairs must be a list");
  return data.pairs.map((p, i) => {
    const { a, b } = (p ?? {}) as { a?: unknown; b?: unknown };
    if (typeof a !== "string" || typeof b !== "string" || !a || !b) throw new Error(`escalate.json: pair ${i + 1} needs a and b`);
    return { a, b, stratum: "escalated" };
  });
}

function setup() {
  const flags = parseFlags(process.argv.slice(2), ["grouping", "per-stratum", "seed", "db", "only"] as const);
  const root = projectRoot();
  const names = parseGroupingNames(flags.grouping ?? (existsSync(relinkItemsPath(root)) ? "current,relink" : "current"));
  const perStratum = Number(flags["per-stratum"] ?? "10");
  const seed = Number(flags.seed ?? "42");
  if (!Number.isInteger(perStratum) || perStratum < 1) throw new Error("--per-stratum must be a positive whole number");
  if (!Number.isInteger(seed)) throw new Error("--seed must be a whole number");

  const session = (openSession = new LabelSession(root));
  // As npm run relink: the database in the directory it runs in, unless --db says otherwise
  const source = (openSource = openReadOnly(resolve(flags.db ?? "workstream.db")));
  const index = loadMessageIndex(source.db);
  const { observations } = index;
  const { groupings } = loadGroupings(names, root, source.db, index);
  const labeled = new Set(session.labels.pairs.map((p) => pairKey(p.a, p.b)));
  const queue = flags.only !== undefined
    ? loadEscalated(root, flags.only).filter((c) => !labeled.has(pairKey(c.a, c.b)))
    : buildQueue(observations, groupings, { perStratum, seed, labeled, senderNames: loadSenderNames(source.db) });
  return { session, source, queue, byId: new Map(observations.map((o) => [o.id, o])) };
}

let state: ReturnType<typeof setup>;
try {
  state = setup();
} catch (err) {
  fail(err);
}
const { session, source, queue, byId } = state;

if (queue.length === 0) {
  stop();
  console.log(session.labels.pairs.length ? "No unlabeled pairs left to draw. Try another --seed, or run: npm run eval:linking" : "No pairs to draw: the groupings place no messages.");
  process.exit(0);
}

let idx = 0;
let note: string | undefined;
/** Non-null while typing a note: keys go into the buffer instead of acting as commands. */
let noteDraft: string | null = null;
/** Pairs skipped once already: a second skip drops them for this session */
const skipped = new Set<string>();

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function oneLine(m: ContextMessage, max = 160): string {
  const text = clean(m.text).replace(/\s+/g, " ").trim();
  return `${clean(m.sender)}: ${text.length > max ? text.slice(0, max) + "…" : text}`;
}

/** How far apart two messages are, or null when a timestamp doesn't parse */
function gap(a: Observation, b: Observation): string | null {
  const minutes = Math.round(Math.abs(Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 60000);
  if (!Number.isFinite(minutes)) return null;
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const isNotWork = (id: string) => session.labels.notWork.some((n) => n.message === id);
const isMixed = (id: string) => session.labels.mixed.some((n) => n.message === id);

/** What the verdicts mean, shown under the keys (docs/streams-and-message-linking.md has the full definitions) */
const HINT = [
  "Same work: both move or discuss one case (one ticket, one PR, one order, or one goal with one partner), updates too.",
  "Different work: different cases, even with the same partner, agent, channel, routine or routine run.",
  "Not work: about no single case: heartbeats, health checks, empty tick logs, chatter, many-case digests or briefings.",
  "A question about one case and its answer: same work. A \"one by one\" walk: not work. Can't see the question: u.",
  "Mixed (a/b): the message moves several cases, like a dispatch of three tickets. Mark it, then still give s or d.",
];

function renderMessage(tag: string, o: Observation | undefined, id: string): void {
  if (!o) {
    console.log(`${BOLD}── ${tag} ──${RESET} ${DIM}(message ${clean(id)} not found)${RESET}\n`);
    return;
  }
  const mark = isNotWork(o.id) ? `  ${BOLD}[not work]${RESET}` : isMixed(o.id) ? `  ${BOLD}[mixed]${RESET}` : "";
  console.log(`${BOLD}── ${tag} ──${RESET} ${clean(o.senderName)} in #${clean(o.channelName)}  ${clean(o.timestamp)}${mark}`);
  const ctx = loadItemContext(source.db, o.eventId, { before: 2, after: 1 });
  for (const m of ctx?.before ?? []) console.log(`${DIM}  before  ${oneLine(m)}${RESET}`);
  console.log(quoted(o.text.length > 1200 ? o.text.slice(0, 1200) + "\n…(truncated)" : o.text));
  for (const m of ctx?.after ?? []) console.log(`${DIM}  after   ${oneLine(m)}${RESET}`);
  console.log("");
}

function render(): void {
  const pair = queue[idx];
  const [a, b] = [byId.get(pair.a), byId.get(pair.b)];
  console.clear();
  const apartBy = a && b ? gap(a, b) : null;
  const where = a && b ? `  ·  ${a.threadId === b.threadId ? "same thread" : "different threads"}${apartBy ? `, ${apartBy} apart` : ""}` : "";
  console.log(`[${idx + 1}/${queue.length} · ${pair.stratum} · ${session.labels.pairs.length} pairs labeled]${where}\n`);
  renderMessage("A", a, pair.a);
  renderMessage("B", b, pair.b);
  console.log("─".repeat(60));
  if (noteDraft !== null) {
    console.log(`  note: ${clean(noteDraft)}█`);
    console.log(`  ${DIM}enter save note · esc cancel${RESET}`);
    return;
  }
  if (note) console.log(`  note: ${clean(note)}`);
  console.log("  s same work · d different work · 1/2 A/B not work · a/b A/B mixed · u unsure, skip · n note · q quit");
  for (const line of HINT) console.log(`  ${DIM}${line}${RESET}`);
}

function next(): void {
  idx++;
  note = undefined;
  if (idx >= queue.length) quit();
  render();
}

function quit(): never {
  stop();
  console.clear();
  console.log(`Saved ${session.labels.pairs.length} pair labels, ${session.labels.notWork.length} not-work marks, ${session.labels.mixed.length} mixed → eval-data/linking/labels.json`);
  console.log("Next: npm run eval:linking");
  process.exit(0);
}

/** Keystrokes while typing a note. Stays in raw mode so command keys can't leak through. */
function noteKey(str: string | undefined, key: { name?: string; ctrl?: boolean }): void {
  if (key.name === "return" || key.name === "enter") {
    note = clean(noteDraft).trim() || undefined;
    noteDraft = null;
  } else if (key.name === "escape") {
    noteDraft = null;
  } else if (key.name === "backspace") {
    noteDraft = noteDraft!.slice(0, -1);
  } else if (str && !key.ctrl && str >= " ") {
    noteDraft += clean(str);
  }
  render();
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
render();

process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  try {
    onKey(str, key);
  } catch (err) {
    // A failed save: the label just given isn't in the file
    fail(err);
  }
});

function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean }): void {
  if (key.ctrl && key.name === "c") quit();
  if (noteDraft !== null) return noteKey(str, key);
  const pair = queue[idx];
  if (key.name === "q") quit();
  if (key.name === "s" || key.name === "d") {
    session.setPair({ a: pair.a, b: pair.b, verdict: key.name === "s" ? "same" : "different", note, labeledAt: new Date().toISOString(), stratum: pair.stratum });
    return next();
  }
  if (str === "1" || str === "2") {
    // A note typed before the mark goes with it
    session.toggleNotWork(str === "1" ? pair.a : pair.b, note);
    note = undefined;
    return render();
  }
  if (key.name === "a" || key.name === "b") {
    session.toggleMark("mixed", key.name === "a" ? pair.a : pair.b, note);
    note = undefined;
    return render();
  }
  if (key.name === "u") {
    const k = pairKey(pair.a, pair.b);
    if (!skipped.has(k)) {
      skipped.add(k);
      queue.push(pair);
    }
    return next();
  }
  if (key.name === "n") { noteDraft = note ?? ""; return render(); }
}
