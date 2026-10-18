// core/eval/linking-sample.ts — Which message pairs to ask the operator about (pure)
//
// Random pairs are almost all "different work, kept apart", which says nothing. The queue is stratified to find both
// kinds of error, drawing from every grouping given so each verdict scores all of them:
//   together:<grouping>  two messages a grouping puts in one item, preferring ones far apart in time, in different
//                        threads and from different senders (over-merges)
//   same-thread          two messages of one thread in different items (splits, from here down)
//   sender-channel-24h   one sender in one channel within 24 hours
//   shared-ref           both name the same ticket or PR in their own lines
//   shared-name          both use the same capitalised word, a cheap stand-in for a shared subject
// A split stratum takes a pair only when some grouping puts the two in different items. Within a stratum, items and
// signal buckets take turns, so one huge item or busy thread can't fill it. A message no grouping places isn't drawn
// for a split stratum, deliberately: a split is two items for one piece of work, and an unplaced message is in none.

import { looksLikeTicketKey } from "../graph/extractors/default.js";
import { pairKey } from "./linking-labels.js";
import type { Grouping } from "./linking-metrics.js";
import type { Observation } from "./linking-data.js";

export const SPLIT_STRATA = ["same-thread", "sender-channel-24h", "shared-ref", "shared-name"] as const;

export interface Candidate {
  a: string;
  b: string;
  stratum: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pairs drawn per item or bucket before the best are kept */
const DRAWS = 12;
/** Pairs kept per item or bucket */
const KEEP = 3;

/** Deterministic PRNG so a queue can be reproduced */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(list: T[], random: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Takes the first of each list in turn, then the second, … */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** How much of a message the signals read: enough for any subject, and a bound on the work per message */
const SIGNAL_TEXT_MAX = 8000;

/**
 * Ticket keys (OPS-101, not technical terms such as UTF-8 or ISO-8601) and pull requests a message names. A PR URL
 * keys as "pr:<owner>/<repo>#7" and a bare "PR #7" as "pr:#7": they don't match each other, since a bare number
 * doesn't say which repository.
 */
export function refsOf(text: string): string[] {
  const head = text.slice(0, SIGNAL_TEXT_MAX);
  const refs = new Set<string>();
  for (const m of head.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)) if (looksLikeTicketKey(m[1])) refs.add(`ticket:${m[1]}`);
  for (const m of head.matchAll(/\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) refs.add(`pr:${m[1].toLowerCase()}#${m[2]}`);
  for (const m of head.matchAll(/\bPR\s*#?(\d+)\b/gi)) refs.add(`pr:#${m[1]}`);
  return [...refs];
}

/** Common capitalised words that say nothing about the subject */
const STOP_WORDS = new Set([
  "The", "This", "That", "These", "Those", "There", "Then", "When", "What", "Which", "Where", "While", "With", "From",
  "Done", "Started", "Starting", "Finished", "Working", "Blocked", "Waiting", "Update", "Status", "Please", "Thanks",
  "Hello", "Also", "Just", "Still", "Will", "Need", "Needs", "Should", "Could", "Would", "Can", "Here", "Have", "Has",
  "Yes", "Okay", "Sure", "Good", "Great", "Note", "Next", "After", "Before", "Today", "Tomorrow", "Yesterday",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Summary", "Approved", "Merged",
]);

/** Capitalised words (4+ letters) that don't open a sentence, aren't common and aren't a sender's name */
export function namesOf(text: string, exclude: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  // The opener takes spaces and tabs only after the punctuation, so a run of newlines is read once, not once per line
  for (const m of text.slice(0, SIGNAL_TEXT_MAX).matchAll(/(^|[.!?\n][ \t]*|\s)([A-Z][a-z]{3,})\b/g)) {
    const opensSentence = m.index === 0 || /[.!?\n]/.test(m[1]);
    const word = m[2];
    if (opensSentence || STOP_WORDS.has(word) || exclude.has(word.toLowerCase())) continue;
    names.add(word);
  }
  return [...names];
}

function apartInSome(groupings: Grouping[], a: string, b: string): boolean {
  return groupings.some((g) => {
    const ia = g.get(a);
    const ib = g.get(b);
    return ia !== undefined && ib !== undefined && ia !== ib;
  });
}

/** How strongly a together-pair suggests an over-merge: different threads, different senders, far apart in time */
function spreadScore(a: Observation, b: Observation): number {
  const gap = Math.abs(Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return (a.threadId !== b.threadId ? 1 : 0) + (a.senderId !== b.senderId ? 1 : 0) + Math.min(1, (gap || 0) / (7 * DAY_MS));
}

function draw<T>(list: T[], random: () => number): [T, T] {
  const i = Math.floor(random() * list.length);
  let j = Math.floor(random() * (list.length - 1));
  if (j >= i) j++;
  return [list[i], list[j]];
}

/** Over-merge candidates for one grouping: per item, its most spread-out pairs; items take turns */
function togetherCandidates(name: string, grouping: Grouping, byId: Map<string, Observation>, random: () => number): Candidate[] {
  const members = new Map<string, Observation[]>();
  for (const [id, item] of grouping) {
    const o = byId.get(id);
    if (!o) continue;
    const list = members.get(item) ?? [];
    list.push(o);
    members.set(item, list);
  }
  const perItem: Candidate[][] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const seen = new Map<string, { c: Candidate; score: number }>();
    for (let i = 0; i < DRAWS; i++) {
      const [a, b] = draw(list, random);
      seen.set(pairKey(a.id, b.id), { c: { a: a.id, b: b.id, stratum: `together:${name}` }, score: spreadScore(a, b) + random() * 0.01 });
    }
    perItem.push([...seen.values()].sort((x, y) => y.score - x.score).slice(0, KEEP).map((s) => s.c));
  }
  return roundRobin(shuffle(perItem, random));
}

/** Split candidates from buckets of messages sharing a signal: pairs some grouping keeps apart; buckets take turns */
function bucketCandidates(
  stratum: string,
  buckets: Iterable<Observation[]>,
  groupings: Grouping[],
  random: () => number,
  pick: (bucket: Observation[]) => [Observation, Observation] | null = (bucket) => draw(bucket, random),
): Candidate[] {
  const perBucket: Candidate[][] = [];
  for (const bucket of buckets) {
    if (bucket.length < 2) continue;
    const found = new Map<string, Candidate>();
    for (let i = 0; i < DRAWS && found.size < KEEP; i++) {
      const pair = pick(bucket);
      if (!pair || !apartInSome(groupings, pair[0].id, pair[1].id)) continue;
      found.set(pairKey(pair[0].id, pair[1].id), { a: pair[0].id, b: pair[1].id, stratum });
    }
    if (found.size) perBucket.push([...found.values()]);
  }
  return roundRobin(shuffle(perBucket, random));
}

function bucketBy(observations: Observation[], keysOf: (o: Observation) => string[]): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const o of observations) {
    for (const k of keysOf(o)) {
      const list = out.get(k) ?? [];
      list.push(o);
      out.set(k, list);
    }
  }
  return out;
}

/** A pair from one sender's messages in one channel (time-ordered) at most 24 hours apart, or null */
function within24h(bucket: Observation[], random: () => number): [Observation, Observation] | null {
  const i = Math.floor(random() * bucket.length);
  const t = Date.parse(bucket[i].timestamp);
  let end = i;
  while (end + 1 < bucket.length && Date.parse(bucket[end + 1].timestamp) - t <= DAY_MS) end++;
  if (end === i) return null;
  return [bucket[i], bucket[i + 1 + Math.floor(random() * (end - i))]];
}

export interface QueueOptions {
  perStratum: number;
  seed: number;
  /** pairKey()s already labeled: never asked again */
  labeled: ReadonlySet<string>;
  /** Names of senders, left out of the shared-name signal */
  senderNames?: string[];
}

/** The candidates of every stratum, before quotas (exported for tests) */
export function candidatesByStratum(observations: Observation[], groupings: Map<string, Grouping>, seed: number, senderNames: string[] = []): Map<string, Candidate[]> {
  const random = mulberry32(seed);
  const byId = new Map(observations.map((o) => [o.id, o]));
  const all = [...groupings.values()];
  const out = new Map<string, Candidate[]>();
  for (const [name, g] of groupings) out.set(`together:${name}`, togetherCandidates(name, g, byId, random));

  out.set("same-thread", bucketCandidates("same-thread", bucketBy(observations, (o) => [o.threadId]).values(), all, random));

  const senderChannel = bucketBy(observations, (o) => (o.senderId && o.channelId ? [`${o.senderId}\u0000${o.channelId}`] : []));
  for (const list of senderChannel.values()) list.sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
  out.set("sender-channel-24h", bucketCandidates("sender-channel-24h", senderChannel.values(), all, random, (b) => within24h(b, random)));

  out.set("shared-ref", bucketCandidates("shared-ref", bucketBy(observations, (o) => refsOf(o.text)).values(), all, random));

  // A word most messages use is no subject: keep words in at most 5% of messages (and at least 20)
  const exclude = new Set(senderNames.flatMap((n) => n.toLowerCase().split(/\s+/)));
  const names = bucketBy(observations, (o) => namesOf(o.text, exclude));
  const cap = Math.max(20, Math.floor(observations.length * 0.05));
  out.set("shared-name", bucketCandidates("shared-name", [...names.values()].filter((l) => l.length <= cap), all, random));
  return out;
}

/**
 * The labeling queue: up to perStratum unlabeled pairs from each stratum, each pair once, with the strata taking
 * turns so a session stopped early still covers all of them.
 */
export function buildQueue(observations: Observation[], groupings: Map<string, Grouping>, options: QueueOptions): Candidate[] {
  const strata = candidatesByStratum(observations, groupings, options.seed, options.senderNames);
  const used = new Set(options.labeled);
  const chosen: Candidate[][] = [];
  for (const candidates of strata.values()) {
    const take: Candidate[] = [];
    for (const c of candidates) {
      if (take.length >= options.perStratum) break;
      const key = pairKey(c.a, c.b);
      if (used.has(key)) continue;
      used.add(key);
      take.push(c);
    }
    chosen.push(take);
  }
  return roundRobin(chosen);
}
