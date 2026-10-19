// core/grouping/lab.ts — The lab's view of the v2 grouping: streams, their cases, and one case's graph (read only)
//
// Served by the engine only with WORKSTREAM_LAB=true (a development aid, docs/work-model.md §3, "The graph"). It reads
// the live database without writing, recomputes when messages have been added (checked at most every 30 seconds), and
// returns each case as a graph: its messages as nodes, and an edge from the message whose evidence drew each one in.

import type BetterSqlite3 from "better-sqlite3";
import { DefaultExtractor } from "../graph/extractors/default.js";
import type { Placement } from "./cluster.js";
import { groupMessages } from "./index.js";
import { actorOfHandle, loadActorNames, loadGroupingMessages, type LoadedMessage } from "./load.js";
import { findAsks, waitFor, type Ask } from "./asks.js";
import { casesFrom, type Case, type Stream } from "./streams.js";

const RECHECK_MS = 30_000;
const MAX_TEXT = 600;

export interface LabNode {
  key: string;
  sender: string;
  senderKind: string;
  channel: string;
  at: string;
  threadId: string;
  topLevel: boolean;
  text: string;
  about: string | null;
  reasons: string[];
}

export interface LabEdge {
  from: string;
  to: string;
  /** The strongest evidence: thread, sameKey, exchange, continuation, followUp, nearCopy, promoted, … */
  reason: string;
}

interface Snapshot {
  version: string;
  messages: Map<string, LoadedMessage>;
  placements: Map<string, Placement>;
  cases: Map<string, Case>;
  streams: Stream[];
  channelNames: Map<string, string>;
  actors: Map<string, string>;
  asks: Ask[];
}

/** The evidence a reason names, without its points: "sameKey ticket:OPS-1 +10" → "sameKey" */
function reasonKind(reasons: readonly string[]): string {
  const promoted = reasons.find((r) => r.startsWith("promoted"));
  return (promoted ? "promoted" : reasons[0] ?? "new").split(/[ ,]/)[0];
}

export class GroupingLab {
  private snapshot: Snapshot | null = null;
  private checkedAt = 0;

  constructor(private readonly db: BetterSqlite3.Database) {}

  private current(): Snapshot {
    const now = Date.now();
    if (this.snapshot && now - this.checkedAt < RECHECK_MS) return this.snapshot;
    this.checkedAt = now;
    const v = this.db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS last FROM events").get() as { n: number; last: number | null };
    const version = `${v.n}:${v.last ?? 0}`;
    if (this.snapshot?.version === version) return this.snapshot;
    const list = loadGroupingMessages(this.db);
    const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
    const placements = groupMessages(list, { extractTickets: (t) => extractor.extractWorkItemIds(t) });
    const messages = new Map(list.map((m) => [m.key, m]));
    const { cases, streams } = casesFrom(placements, new Map(list.map((m) => [m.key, { at: m.at, channelId: m.channelId }])));
    const channelNames = new Map(list.filter((m) => m.channelId && m.channelName).map((m) => [m.channelId!, m.channelName]));
    const actors = loadActorNames(this.db);
    const byName = new Map([...actors].map(([id, name]) => [name.trim().toLowerCase(), id]));
    const asks = findAsks(list, placements, byName, actorOfHandle(actors));
    this.snapshot = { version, messages, placements, cases: new Map(cases.map((c) => [c.id, c])), streams, channelNames, actors, asks };
    return this.snapshot;
  }

  /** What a stream is called: a channel's by its name ("#ops"), others by their key */
  private label(key: string): string {
    if (!key.startsWith("channel:")) return key;
    const name = this.current().channelNames.get(key.slice("channel:".length));
    return name ? `#${name}` : key;
  }

  /**
   * A case's status: its latest message's classification; waiting when that is blocked on someone or a decision
   * (what's stuck, by stream: the lab's view of what to unblock)
   */
  private statusOf(c: Case): { status: string | null; waiting: boolean; needsYou: boolean } {
    const last = this.current().messages.get(c.members[c.members.length - 1].key);
    const status = last?.status ?? null;
    const waiting = status === "blocked_on_human" || status === "needs_decision";
    // Waiting, and the classifier put it in front of the operator: what Needs me holds, by case
    return { status, waiting, needsYou: waiting && Boolean(last?.targetedAtOperator) };
  }

  /** Streams, most recently active first, optionally those whose key or name contains `q`, or only those waiting */
  streams(q?: string, limit = 200, filter: "all" | "waiting" | "needsYou" = "all"): {
    streams: Array<Omit<Stream, "cases"> & { caseCount: number; waiting: number; needsYou: number; label: string }>;
    total: number;
  } {
    const snap = this.current();
    const all = snap.streams.map((s) => ({
      key: s.key,
      messages: s.messages,
      last: s.last,
      caseCount: s.cases.length,
      waiting: s.cases.filter((id) => this.statusOf(snap.cases.get(id)!).waiting).length,
      needsYou: s.cases.filter((id) => this.statusOf(snap.cases.get(id)!).needsYou).length,
      label: this.label(s.key),
    }));
    const needle = q?.trim().toLowerCase();
    const matched = all.filter((s) => (!needle || s.key.toLowerCase().includes(needle) || s.label.toLowerCase().includes(needle)) && (filter === "all" || (filter === "waiting" ? s.waiting > 0 : s.needsYou > 0)));
    return { streams: matched.slice(0, limit), total: matched.length };
  }

  /** A stream's cases, most recent first, each with the start of its first message as a title */
  stream(key: string): { stream: Stream; cases: Array<{ id: string; keys: string[]; size: number; first: string; last: string; title: string; status: string | null; waiting: boolean; needsYou: boolean }> } | null {
    const snap = this.current();
    const stream = snap.streams.find((s) => s.key === key);
    if (!stream) return null;
    const cases = stream.cases.map((id) => snap.cases.get(id)!).map((c) => ({
      id: c.id,
      keys: c.keys,
      size: c.members.length,
      first: c.first,
      last: c.last,
      title: (snap.messages.get(c.members[0].key)?.text ?? "").replace(/\s+/g, " ").slice(0, 140),
      ...this.statusOf(c),
    }));
    return { stream, cases };
  }

  /**
   * The cases a case touches: keys its messages mention without being about (a ticket it waits on, another partner),
   * each with the cases about it. The neighbourhood of a case in the graph (docs/work-model.md §3).
   */
  private connections(c: Case): Array<{ key: string; cases: Array<{ id: string; title: string; size: number; status: string | null }> }> {
    const snap = this.current();
    const own = new Set(c.keys);
    const mentioned = new Set<string>();
    for (const m of c.members) for (const k of snap.placements.get(m.key)?.recognized.mentions ?? []) if (!own.has(k)) mentioned.add(k);
    const out: Array<{ key: string; cases: Array<{ id: string; title: string; size: number; status: string | null }> }> = [];
    for (const key of mentioned) {
      const holders = [...snap.cases.values()].filter((o) => o.id !== c.id && o.keys.includes(key));
      out.push({
        key,
        cases: holders.slice(0, 5).map((o) => ({
          id: o.id,
          title: (snap.messages.get(o.members[0].key)?.text ?? "").replace(/\s+/g, " ").slice(0, 100),
          size: o.members.length,
          status: this.statusOf(o).status,
        })),
      });
    }
    return out.sort((a, b) => b.cases.length - a.cases.length || (a.key < b.key ? -1 : 1)).slice(0, 20);
  }

  /**
   * Who is waiting on whom: the wait-for graph of asks still open from the last `days` days, with actors' names, the
   * open asks on each (newest first, with their case), cycles and root blockers
   */
  waiting(days = 14): {
    waitedOn: Array<{ actor: string; name: string; open: number; blocking: number; by: string[]; oldest: string; asks: Array<{ from: string; at: string; caseId: string | null; text: string; strength: string }> }>;
    edges: Array<{ from: string; to: string; open: number; blocking: number }>;
    cycles: string[][];
    rootBlockers: Array<{ actor: string; root: string; path: string[] }>;
  } {
    const snap = this.current();
    const latest = [...snap.messages.values()].reduce((max, m) => (m.at > max ? m.at : max), "");
    const since = new Date(Date.parse(latest || new Date().toISOString()) - days * 86_400_000).toISOString();
    const graph = waitFor(snap.asks, since);
    const name = (id: string) => snap.actors.get(id) ?? id;
    const live = snap.asks.filter((a) => !a.answeredAt && a.at >= since);
    const edgeCount = new Map<string, { open: number; blocking: number }>();
    for (const a of live) {
      const e = edgeCount.get(`${a.from}>${a.to}`) ?? { open: 0, blocking: 0 };
      e.open++;
      if (a.strength === "blocks") e.blocking++;
      edgeCount.set(`${a.from}>${a.to}`, e);
    }
    return {
      waitedOn: graph.waitedOn.map((w) => ({
        ...w,
        name: name(w.actor),
        by: w.by.map(name),
        asks: live.filter((a) => a.to === w.actor).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 10).map((a) => ({
          from: name(a.from),
          at: a.at,
          caseId: a.caseId,
          text: (snap.messages.get(a.message)?.text ?? "").replace(/\s+/g, " ").slice(0, 160),
          strength: a.strength,
        })),
      })),
      edges: [...edgeCount].map(([k, e]) => {
        const [from, to] = k.split(">");
        return { from: name(from), to: name(to), ...e };
      }),
      cycles: graph.cycles.map((c) => c.map(name)),
      rootBlockers: graph.rootBlockers.map((r) => ({ actor: name(r.actor), root: name(r.root), path: r.path.map(name) })),
    };
  }

  /** One case as a graph: its messages, the edges that drew them in, and the cases it touches */
  case(id: string): {
    case: { id: string; keys: string[]; stream: string; streamLabel: string };
    nodes: LabNode[];
    edges: LabEdge[];
    connections: ReturnType<GroupingLab["connections"]>;
  } | null {
    const snap = this.current();
    const c = snap.cases.get(id);
    if (!c) return null;
    const inCase = new Set(c.members.map((m) => m.key));
    const nodes: LabNode[] = c.members.map((m) => {
      const msg = snap.messages.get(m.key)!;
      return {
        key: m.key,
        sender: msg.senderName,
        senderKind: msg.senderKind,
        channel: msg.channelName,
        at: msg.at,
        threadId: msg.threadId,
        topLevel: msg.topLevel ?? false,
        text: msg.text.slice(0, MAX_TEXT),
        about: snap.placements.get(m.key)?.recognized.about ?? null,
        reasons: m.reasons,
      };
    });
    const edges: LabEdge[] = c.members
      .filter((m) => m.via && inCase.has(m.via) && m.via !== m.key)
      .map((m) => ({ from: m.via!, to: m.key, reason: reasonKind(m.reasons) }));
    return { case: { id: c.id, keys: c.keys, stream: c.stream, streamLabel: this.label(c.stream) }, nodes, edges, connections: this.connections(c) };
  }
}
