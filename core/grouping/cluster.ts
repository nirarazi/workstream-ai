// core/grouping/cluster.ts — Group messages into cases by scored evidence under constraints (docs/work-model.md §5)
//
// Messages are taken in time order. Each one that is work is scored against the open clusters that are its candidates
// (one holding the key it's about, its thread's, its sender's message just before, a near-copy of it) and joins the
// best one that clears the bar; otherwise it starts a cluster of its own. Reports, telemetry and noise join nothing.
// Evidence is explainable: every placement records the reasons that scored it. Constraints win over everything: a
// cannot_link keeps a message out of a cluster holding the other end, a must_link or pin puts it in.
//
// Pure and deterministic: the same messages, constraints and weights give the same clusters.

import type { ResolverOptions } from "../graph/resolver.js";
import { recognize, SubjectLexicon, type GroupingMessage, type Recognized } from "./recognize.js";

export interface Weights {
  /** Holds the key the message is about */
  sameKey: number;
  /** Holds a subject the message only names, untagged: weaker than a reply's thread */
  namedSubject: number;
  /** The message's thread belongs to the cluster */
  thread: number;
  /** The thread's cluster is about a different key than the message */
  otherKeyInThread: number;
  /** The same person's message just before, in the same channel, and this one names nothing */
  followUp: number;
  /** The same sender (a person or an agent) going on, a little later, with neither message naming a key */
  continuation: number;
  /** A reply, as a top-level post, to someone else's message in the same channel just before (a person in it) */
  exchange: number;
  /** A near-copy of the same sender's message just before */
  nearCopy: number;
  /** The bar a candidate's score must clear */
  join: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  sameKey: 10,
  namedSubject: 5,
  thread: 6,
  otherKeyInThread: -8,
  followUp: 5,
  continuation: 3,
  exchange: 3,
  nearCopy: 5,
  join: 3,
};

export interface ClusterOptions extends ResolverOptions {
  weights?: Partial<Weights>;
  /** A person's follow-up joins their previous message within this long */
  followUpMs?: number;
  /** A near-copy joins within this long */
  nearCopyMs?: number;
  /** A sender's keyless continuation joins within this long */
  continuationMs?: number;
  /** A top-level reply to someone else joins within this long */
  exchangeMs?: number;
  /** Live, applied constraints, by message key (observations' dedupeKeys or the eval's message keys) */
  constraints?: Array<{ kind: "must_link" | "cannot_link" | "pin" | "not_an_item"; a: string; b: string | null }>;
}

export interface Placement {
  cluster: string | null;
  recognized: Recognized;
  /** Why it went where it did: "sameKey ticket:OPS-1 +10", "thread +4", … */
  reasons: string[];
  /** The message whose evidence drew it in most (its thread's last, the first with its key, …): an edge of the graph */
  via: string | null;
}

interface Cluster {
  id: string;
  keys: Set<string>;
  members: string[];
}

const MINUTE = 60_000;

/**
 * Subject names from routines' tagged lines, for naming them in untagged messages: a name tagged at least twice (so
 * one stray tagged line can't add a subject), of two words or six letters or more
 */
function subjectLexicon(messages: readonly GroupingMessage[], options: ClusterOptions): SubjectLexicon {
  const seen = new Map<string, number>();
  for (const m of messages) {
    const r = recognize(m, options);
    if (r.aboutBy === "tagged" && r.about?.startsWith("subject:")) {
      const name = r.about.slice("subject:".length);
      if (name.split(" ").length >= 2 || name.length >= 6) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  return new SubjectLexicon([...seen].filter(([, n]) => n >= 2).map(([name]) => name));
}

/**
 * The cluster of a subject named a little differently: one name the other's first words ("spring26 offer" and "spring26
 * offer check"), at least two words or one of six letters or more in common, so "Dana" alone doesn't match "Dana Lee".
 */
function similarSubject(byKey: ReadonlyMap<string, string>, key: string): string | undefined {
  if (!key.startsWith("subject:")) return undefined;
  const words = key.slice("subject:".length).split(" ");
  for (const [other, id] of byKey) {
    if (!other.startsWith("subject:")) continue;
    const theirs = other.slice("subject:".length).split(" ");
    const [short, long] = words.length <= theirs.length ? [words, theirs] : [theirs, words];
    if (short.length === long.length) continue;
    if (!short.every((w, i) => long[i] === w)) continue;
    if (short.length >= 2 || short[0].length >= 6) return id;
  }
  return undefined;
}

/** Word-set overlap of two texts (Jaccard), for near-copies */
function overlap(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

export function cluster(messages: readonly GroupingMessage[], options: ClusterOptions): Map<string, Placement> {
  const w = { ...DEFAULT_WEIGHTS, ...options.weights };
  const followUpMs = options.followUpMs ?? 10 * MINUTE;
  const nearCopyMs = options.nearCopyMs ?? 3 * MINUTE;
  const continuationMs = options.continuationMs ?? 30 * MINUTE;
  const exchangeMs = options.exchangeMs ?? 10 * MINUTE;
  // Time order, ties by key; a message given twice counts once
  const unique = [...new Map(messages.map((m) => [m.key, m])).values()];
  const sorted = unique.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // The subjects routines name in their tagged lines, so a message naming one untagged is about it too
  const subjects = subjectLexicon(sorted, options);

  const notAnItem = new Set<string>();
  const cannot = new Map<string, Set<string>>();
  const must = new Map<string, Set<string>>();
  const pins = new Map<string, string>();
  const link = (m: Map<string, Set<string>>, a: string, b: string) => {
    m.set(a, (m.get(a) ?? new Set()).add(b));
    m.set(b, (m.get(b) ?? new Set()).add(a));
  };
  for (const c of options.constraints ?? []) {
    if (c.kind === "not_an_item") notAnItem.add(c.a);
    else if (c.kind === "pin" && c.b) pins.set(c.a, c.b);
    else if (c.kind === "cannot_link" && c.b) link(cannot, c.a, c.b);
    else if (c.kind === "must_link" && c.b) link(must, c.a, c.b);
  }

  const clusters = new Map<string, Cluster>();
  const byKey = new Map<string, string>();
  const ofMessage = new Map<string, string>();
  const threadCluster = new Map<string, string>();
  const threadOf = new Map<string, string>();
  /** For the graph's edges: a cluster's first message with its key, and each thread's last placed message */
  const firstWithKey = new Map<string, string>();
  const lastInThread = new Map<string, string>();
  /** Whether the operator kept a message apart from anything in a cluster */
  const cannotWith = (key: string, clusterId: string) =>
    [...(cannot.get(key) ?? [])].some((other) => ofMessage.get(other) === clusterId);
  const lastBySender = new Map<string, { message: GroupingMessage; cluster: string; about: string | null }>();
  const lastInChannel = new Map<string, { message: GroupingMessage; cluster: string }>();
  const out = new Map<string, Placement>();
  let next = 0;

  for (const m of sorted) {
    const recognized = recognize(m, { ...options, subjects });
    // The operator's pin or link says it's work, whatever the recognizers make of it
    const tied = pins.has(m.key) || must.has(m.key);
    if (notAnItem.has(m.key) || (recognized.kind !== "work" && !tied)) {
      out.set(m.key, { cluster: null, recognized, reasons: [notAnItem.has(m.key) ? "operator: not an item" : recognized.kind], via: null });
      continue;
    }
    const about = pins.get(m.key) ?? recognized.about;
    const scores = new Map<string, { score: number; reasons: string[]; via: string | null; strongest: number }>();
    const add = (id: string | undefined, points: number, reason: string, via: string | null | undefined) => {
      if (!id) return;
      const s = scores.get(id) ?? { score: 0, reasons: [], via: null, strongest: 0 };
      s.score += points;
      s.reasons.push(`${reason} ${points >= 0 ? "+" : ""}${points}`);
      if (via && points > s.strongest) {
        s.via = via;
        s.strongest = points;
      }
      scores.set(id, s);
    };

    const named = recognized.aboutBy === "named" && !pins.has(m.key);
    if (about) {
      const holder = byKey.get(about) ?? similarSubject(byKey, about);
      add(holder, named ? w.namedSubject : w.sameKey, `${named ? "namedSubject" : "sameKey"} ${about}`, holder ? firstWithKey.get(holder) : null);
    }
    const inThread = threadCluster.get(m.threadId);
    if (inThread) {
      const keys = clusters.get(inThread)!.keys;
      // A subject only named in passing doesn't take a reply out of its thread
      const otherKey = about !== null && !named && keys.size > 0 && !keys.has(about);
      // However long after: on the labelled pairs, a late reply in a thread is still that thread's work
      add(inThread, otherKey ? w.otherKeyInThread : w.thread, otherKey ? "thread, about another key" : "thread", lastInThread.get(m.threadId));
    }
    const senderSlot = `${m.senderId ?? "?"}|${m.channelId ?? "?"}`;
    const before = lastBySender.get(senderSlot);
    if (before) {
      const gap = Date.parse(m.at) - Date.parse(before.message.at);
      const keyless = !about && recognized.mentions.length === 0;
      if (m.senderKind === "human" && keyless && gap <= followUpMs) add(before.cluster, w.followUp, "followUp", before.message.key);
      else if (keyless && !before.about && gap <= continuationMs) add(before.cluster, w.continuation, "continuation", before.message.key);
      // A near-copy about another key is a template ("OPS-1 status: …", then "OPS-2 status: …"), not the same post
      const sameSubject = !about || !before.about || about === before.about;
      if (sameSubject && gap <= nearCopyMs && overlap(m.text, before.message.text) >= 0.6) add(before.cluster, w.nearCopy, "nearCopy", before.message.key);
    }
    // A top-level post answering someone else's just before it in the channel, where a person is one of the two
    const lastHere = m.channelId ? lastInChannel.get(m.channelId) : undefined;
    if (lastHere && m.topLevel && !about
      && lastHere.message.senderId !== m.senderId
      && (m.senderKind === "human" || lastHere.message.senderKind === "human")
      && Date.parse(m.at) - Date.parse(lastHere.message.at) <= exchangeMs) {
      add(lastHere.cluster, w.exchange, "exchange", lastHere.message.key);
    }
    for (const other of must.get(m.key) ?? []) add(ofMessage.get(other), 1000, "operator: must link", other);
    // A cluster holding a message the operator kept apart from this one is out
    for (const other of cannot.get(m.key) ?? []) {
      const id = ofMessage.get(other);
      if (id) scores.set(id, { score: -Infinity, reasons: ["operator: cannot link"], via: null, strongest: 0 });
    }

    let best: { id: string; score: number; reasons: string[]; via: string | null } | null = null;
    for (const [id, s] of scores) if (!best || s.score > best.score || (s.score === best.score && id < best.id)) best = { id, ...s };
    let id: string;
    let reasons: string[];
    let via: string | null = null;
    if (best && best.score >= w.join) {
      id = best.id;
      reasons = best.reasons;
      via = best.via;
    } else {
      id = `c${++next}`;
      clusters.set(id, { id, keys: new Set(), members: [] });
      reasons = ["new"];
    }
    // Promotion: a reply that joins a key's case by that key takes its thread's keyless conversation along, when the
    // conversation lives only in this thread (a merge of what was one case all along)
    const threadOwn = threadCluster.get(m.threadId);
    if (threadOwn && threadOwn !== id && about && !named && byKey.get(about) === id) {
      const conv = clusters.get(threadOwn)!;
      const onlyHere = conv.keys.size === 0 && conv.members.every((k) => threadOf.get(k) === m.threadId);
      if (onlyHere && !conv.members.some((k) => cannotWith(k, id))) {
        for (const k of conv.members) {
          ofMessage.set(k, id);
          clusters.get(id)!.members.push(k);
          const p = out.get(k)!;
          out.set(k, { ...p, cluster: id, reasons: [...p.reasons, `promoted with ${about}`], via: p.via ?? m.key });
        }
        for (const [slot, last] of lastBySender) if (last.cluster === threadOwn) lastBySender.set(slot, { ...last, cluster: id });
        for (const [ch, last] of lastInChannel) if (last.cluster === threadOwn) lastInChannel.set(ch, { ...last, cluster: id });
        clusters.delete(threadOwn);
        threadCluster.set(m.threadId, id);
      }
    }
    const c = clusters.get(id)!;
    c.members.push(m.key);
    threadOf.set(m.key, m.threadId);
    if (about && !byKey.has(about)) {
      c.keys.add(about);
      byKey.set(about, id);
      firstWithKey.set(id, m.key);
    }
    ofMessage.set(m.key, id);
    if (!threadCluster.has(m.threadId)) threadCluster.set(m.threadId, id);
    lastBySender.set(senderSlot, { message: m, cluster: id, about });
    if (m.channelId) lastInChannel.set(m.channelId, { message: m, cluster: id });
    lastInThread.set(m.threadId, m.key);
    out.set(m.key, { cluster: id, recognized, reasons, via });
  }
  return out;
}
