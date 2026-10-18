// core/graph/resolver.ts — Decides which work item a message belongs to, by deterministic rules only
//
// A work item is a deliverable: a ticket, a PR, a case for one subject, or a conversation that asks for something.
// Its identity is a set of keys ("ticket:OPS-101", "pr:forge.example/org/repo#7", "thread:<thread id>",
// "subject:<lane>:<subject>", "mcp:<agent-supplied id>"), and a message resolves to an item by looking its keys up.
//
// The rules, tried in order (the first that decides wins):
//   1. mcp     an agent pushed the message over MCP with a work item id: that id
//   2. thread  the message's thread already belongs to an item. If that item has only thread keys and the sender's
//              own lines are about exactly one ticket, PR or subject, the item gains that key (or merges into the
//              item that already holds it: "promotion")
//   3. ref     the sender's own lines are about exactly one ticket, PR or subject
//   4. reply   the platform says the message replies to, quotes or forwards a message that belongs to an item
//   (5.        the model chooses among candidates: not here. The resolver says "undecided" and what rule 6 would do)
//   6. new     a message that asks for something, or a conversation with replies, starts an item keyed by its
//              thread. A lone progress or completion note with no key is activity, not an item.
//
// Reports (digests, heartbeats, roundups) and notifications never create an item and never link two items: the
// tickets they name are mentions, i.e. updates to those tickets' items. No model is called, nothing is written, and
// nothing here knows which messaging platform a message came from: thread ids and message refs are opaque.

import type { StatusCategory } from "../types.js";
import { DIGEST_MIN_ITEMS } from "./linker.js";
import { ownLines } from "./own-lines.js";

export type KeyKind = "ticket" | "pr" | "subject" | "thread" | "mcp";

/** A work item key as a string: "<kind>:<value>" */
export type ItemKey = string;

export function itemKey(kind: KeyKind, value: string): ItemKey {
  return `${kind}:${value}`;
}

export function keyKind(key: ItemKey): KeyKind {
  return key.slice(0, key.indexOf(":")) as KeyKind;
}

export type SenderKind = "agent" | "human" | "notification" | "unknown";

/** What a message is, decided before any linking */
export type MessageKind = "work" | "report" | "notification";

export interface ResolverMessage {
  threadId: string;
  /** Opaque ids of the sender and channel, for subject rules scoped to one agent or channel */
  senderId?: string | null;
  channelId?: string | null;
  senderKind: SenderKind;
  text: string;
  /** The message's classification, where known. Unknown is read as in progress. */
  status?: StatusCategory | null;
  /** The work item id an agent pushed with the message over MCP */
  mcpWorkItemId?: string | null;
  /** Opaque refs of messages this one replies to, quotes or forwards, where the platform says so */
  refersTo?: string[];
  /** How many earlier messages of this thread have been seen */
  priorInThread: number;
  /** Already flagged as a digest upstream (the pipeline's events.digest) */
  digest?: boolean;
}

/** The read-only view of the graph the resolver needs */
export interface ResolverGraph {
  /** The item holding this key, if any */
  itemForKey(key: ItemKey): string | null;
  /** The keys an item holds */
  keysOf(itemId: string): readonly ItemKey[];
  /** The item a message (by its opaque ref) belongs to, if any */
  itemForMessage(ref: string): string | null;
}

/**
 * A configured subject rule. `pattern` is matched against the first line of the sender's own lines; its named groups
 * `subject` (required) and `lane` (optional) make the key "subject:<lane>:<subject>", lowercased and trimmed.
 */
export interface SubjectRule {
  pattern: string;
  /** Only messages from this sender id */
  sender?: string;
  /** Only messages in this channel id */
  channel?: string;
}

export interface ResolverOptions {
  /** Ticket keys in a text (e.g. a DefaultExtractor's extractWorkItemIds) */
  extractTickets(text: string): string[];
  subjectRules?: SubjectRule[];
}

export type ResolvedBy = "mcp" | "thread" | "ref" | "reply" | "new";

export type Resolution =
  /** Belongs to `itemId`, which gains `addKeys`. Items in `merge` fold into it (they held nothing it conflicts with). */
  | { action: "join"; itemId: string; addKeys: ItemKey[]; merge: string[]; rule: ResolvedBy; promoted: boolean; kind: MessageKind; mentions: ItemKey[] }
  /** Starts a new item holding `keys` */
  | { action: "create"; keys: ItemKey[]; rule: ResolvedBy; kind: MessageKind; mentions: ItemKey[] }
  /** Belongs to no item: a report, a notification or a note with nothing to attach to, or noise */
  | { action: "none"; reason: "report" | "notification" | "activity" | "noise"; kind: MessageKind; mentions: ItemKey[] }
  /**
   * Rules 1–4 didn't decide. The model may choose an existing item; otherwise `fallback` (rule 6) applies.
   * `ambiguous`: the message names several tickets or PRs with none of them as its subject.
   */
  | { action: "undecided"; ambiguous: boolean; fallback: Resolution; kind: MessageKind; mentions: ItemKey[] };

// --- Refs: what a message names in its sender's own lines ---------------------------------------------------------

/** Forge pull/merge request URLs: https://host/org/repo/pull/7, https://host/group/repo/-/merge_requests/7 */
const PR_URL = /https?:\/\/([^\s/|>]+)\/((?:[^\s/|>]+\/)+?)(?:-\/)?(?:pull|pulls|merge_requests)\/(\d+)/gi;

/** PR keys in a text, canonicalised as "host/path#N" so the same PR always gets the same key */
export function extractPullRequests(text: string): string[] {
  const keys = new Set<string>();
  PR_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_URL.exec(text)) !== null) {
    keys.add(`${m[1].toLowerCase()}/${m[2].replace(/\/$/, "").toLowerCase()}#${m[3]}`);
  }
  return [...keys];
}

/** A list item: "- x", "* x", "• x", "1. x", "2) x" */
const LIST_LINE = /^\s*(?:[-*•◦▪]|\d+[.)])\s+/;

interface LineRefs {
  line: string;
  refs: ItemKey[];
}

function refsByLine(text: string, options: ResolverOptions): LineRefs[] {
  return text.split("\n").map((line) => ({
    line,
    refs: [
      ...options.extractTickets(line).map((t) => itemKey("ticket", t)),
      ...extractPullRequests(line).map((p) => itemKey("pr", p)),
    ],
  }));
}

/** The subject key a configured rule finds in the message's first own line, if any */
export function subjectKey(message: ResolverMessage, own: string, rules: SubjectRule[] | undefined): ItemKey | null {
  if (!rules?.length) return null;
  const first = own.split("\n").find((l) => l.trim())?.trim() ?? "";
  for (const rule of rules) {
    if (rule.sender && rule.sender !== message.senderId) continue;
    if (rule.channel && rule.channel !== message.channelId) continue;
    const m = new RegExp(rule.pattern).exec(first);
    const subject = m?.groups?.subject?.trim().toLowerCase();
    if (!subject) continue;
    const lane = m?.groups?.lane?.trim().toLowerCase() ?? "";
    return itemKey("subject", `${lane}:${subject.replace(/\s+/g, " ")}`);
  }
  return null;
}

/** A ticket leads the first line when fewer than this many words come before it ("Done OPS-101 —", "Started work on OPS-101:") */
const LEAD_WORDS = 4;

/**
 * The one ticket or PR a message is about, among those its own lines name: the only one, or the ticket its first line
 * leads with (that line isn't a list item, and doesn't pair it with the next: "OPS-101 and ENG-202"). The rest, in
 * lists and later lines, are mentions. A PR
 * named together with exactly one ticket belongs to that ticket's item, so the pair counts as one subject.
 * Returns null with ambiguous=true when several are named and none leads.
 */
export function aboutRef(lines: LineRefs[]): { subject: ItemKey | null; extra: ItemKey[]; ambiguous: boolean } {
  const all = [...new Set(lines.flatMap((l) => l.refs))];
  if (all.length === 0) return { subject: null, extra: [], ambiguous: false };
  const tickets = all.filter((k) => keyKind(k) === "ticket");
  const prs = all.filter((k) => keyKind(k) === "pr");
  if (all.length === 1) return { subject: all[0], extra: [], ambiguous: false };
  if (tickets.length === 1 && prs.length === 1) return { subject: tickets[0], extra: prs, ambiguous: false };

  const first = lines.find((l) => l.line.trim());
  if (first && !LIST_LINE.test(first.line)) {
    const line = first.line.trim();
    // The first line's tickets in the order they appear
    const placed = [...new Set(first.refs)]
      .filter((k) => keyKind(k) === "ticket")
      .map((k) => ({ key: k, at: line.indexOf(k.slice("ticket:".length)) }))
      .filter((p) => p.at >= 0)
      .sort((a, b) => a.at - b.at);
    const lead = placed[0];
    if (lead && line.slice(0, lead.at).trim().split(/\s+/).filter(Boolean).length < LEAD_WORDS) {
      // "Fixing OPS-101 and ENG-202" names two equally; "Done OPS-101: also unblocks ENG-202" leads with one
      const next = placed[1];
      const between = next ? line.slice(lead.at + lead.key.length - "ticket:".length, next.at) : "";
      if (!next || !/^\s*(?:,|and|&|\+|\/|or)?\s*$/i.test(between)) {
        return { subject: lead.key, extra: [], ambiguous: false };
      }
    }
  }
  return { subject: null, extra: [], ambiguous: true };
}

// --- Report detection ---------------------------------------------------------------------------------------------

/**
 * A first line that announces a report: "Daily digest", "*Night summary*", "Heartbeat:", ":memo: Status report",
 * "Weekly sync". A bare "Status:" or "Update:" isn't one: that's usually one piece of work's news.
 */
const REPORT_HEADER = new RegExp(
  String.raw`^[\s*_#~` + "`" + String.raw`]*(?::[\w+-]+:\s*)*[\s*_#~` + "`" + String.raw`]*` +
    String.raw`(?:(?:(?:daily|weekly|nightly|night|morning|evening|shift|sprint|queue|fleet)\s+)?` +
    String.raw`(?:digest|summary|roundup|round-up|recap|stand-?up|heartbeat|status report)` +
    String.raw`|(?:daily|weekly|nightly|night|morning|evening|shift|sprint|queue|fleet)\s+(?:status|report|sync|audit|update|plan))\b`,
  "i",
);

/** "Nothing changed since …", "No changes since …", "Idle since …": a tick, not news */
const NO_CHANGE = /\b(?:nothing (?:has )?changed|no (?:new )?changes since|no updates? since|idle since|still idle)\b/i;

/**
 * Whether a message is a report: a digest or roundup naming several items, a list whose items each carry a
 * different ticket, a report header, or a no-change tick. Humans' messages never are (the pipeline treats them the
 * same way). `ownKeys` are the keys of the thread's own item: a reply in a ticket's thread naming it isn't a digest.
 */
export function isReport(message: ResolverMessage, lines: LineRefs[], ownKeys: readonly ItemKey[] = []): boolean {
  if (message.senderKind === "human") return false;
  if (message.digest) return true;
  const own = new Set(ownKeys);
  const named = new Set(lines.flatMap((l) => l.refs).filter((k) => !own.has(k)));
  if (named.size >= DIGEST_MIN_ITEMS) return true;

  const listed = new Set<ItemKey>();
  let listLines = 0;
  for (const l of lines) {
    if (LIST_LINE.test(l.line) && l.refs.length > 0) {
      listLines++;
      for (const r of l.refs) listed.add(r);
    }
  }
  if (listLines >= 2 && listed.size >= 2) return true;

  const first = lines.find((l) => l.line.trim())?.line ?? "";
  if (NO_CHANGE.test(first)) return true;
  // A header with one ticket is that ticket's status, not a report
  return REPORT_HEADER.test(first) && named.size !== 1;
}

// --- The resolver -------------------------------------------------------------------------------------------------

function asks(status: StatusCategory | null | undefined): boolean {
  return status === "blocked_on_human" || status === "needs_decision";
}

/** Rule 6: what a message nothing else placed becomes */
function newItem(message: ResolverMessage, kind: MessageKind, mentions: ItemKey[]): Resolution {
  const threadKey = itemKey("thread", message.threadId);
  if (kind === "report") return { action: "none", reason: "report", kind, mentions };
  if (message.status === "noise") return { action: "none", reason: "noise", kind, mentions };
  if (kind === "notification") return { action: "none", reason: "notification", kind, mentions };
  // An ask, a person's message, or a conversation (it has replies) is something to follow
  if (asks(message.status) || message.senderKind === "human" || message.priorInThread > 0) {
    return { action: "create", keys: [threadKey], rule: "new", kind, mentions };
  }
  // A lone progress or completion note with no key: activity, not a deliverable
  return { action: "none", reason: "activity", kind, mentions };
}

export function resolve(message: ResolverMessage, graph: ResolverGraph, options: ResolverOptions): Resolution {
  const threadKey = itemKey("thread", message.threadId);
  const own = ownLines(message.text);
  const lines = refsByLine(own, options);
  const threadItem = graph.itemForKey(threadKey);
  const threadItemKeys = threadItem ? graph.keysOf(threadItem) : [];

  const report = isReport(message, lines, threadItemKeys);
  const kind: MessageKind = report ? "report" : message.senderKind === "notification" ? "notification" : "work";
  const about = report ? { subject: null, extra: [], ambiguous: false } : aboutRef(lines);
  const subject = about.subject ?? (report ? null : subjectKey(message, own, options.subjectRules));
  const subjectKeys = subject ? [subject, ...about.extra] : [];
  const named = [...new Set(lines.flatMap((l) => l.refs))];
  /** What the message names besides the keys of the item it lands on: updates to those, never links */
  const besides = (keys: readonly ItemKey[]) => named.filter((k) => !keys.includes(k));
  const mentions = besides(subjectKeys);

  // 1. MCP: the agent said which item
  if (message.mcpWorkItemId) {
    const ticket = options.extractTickets(message.mcpWorkItemId);
    const key = ticket.length === 1 && ticket[0] === message.mcpWorkItemId
      ? itemKey("ticket", ticket[0])
      : itemKey("mcp", message.mcpWorkItemId);
    const held = graph.itemForKey(key);
    return held
      ? { action: "join", itemId: held, addKeys: [], merge: [], rule: "mcp", promoted: false, kind, mentions: besides(graph.keysOf(held)) }
      : { action: "create", keys: [key], rule: "mcp", kind, mentions: besides([key]) };
  }

  // 2. Thread membership, with promotion of a thread-only item to the key it turns out to be about
  if (threadItem) {
    const threadOnly = threadItemKeys.every((k) => keyKind(k) === "thread");
    if (kind !== "report" && threadOnly && subjectKeys.length > 0) {
      const holders = [...new Set(subjectKeys.map((k) => graph.itemForKey(k)).filter((i): i is string => i !== null && i !== threadItem))];
      if (holders.length === 1) {
        // The key's item absorbs the thread's: it gains the thread's keys and any of these it lacks
        const target = holders[0];
        const missing = subjectKeys.filter((k) => graph.itemForKey(k) !== target);
        return { action: "join", itemId: target, addKeys: missing, merge: [threadItem], rule: "thread", promoted: true, kind, mentions: besides([...graph.keysOf(target), ...subjectKeys]) };
      }
      if (holders.length === 0) {
        return { action: "join", itemId: threadItem, addKeys: subjectKeys, merge: [], rule: "thread", promoted: true, kind, mentions };
      }
      // The ticket and its PR are held by two different items: not this rule's call to merge them
    }
    return { action: "join", itemId: threadItem, addKeys: [], merge: [], rule: "thread", promoted: false, kind, mentions: besides(threadItemKeys) };
  }

  // 3. The one ticket, PR or subject the sender's own lines are about (never a report's)
  if (subjectKeys.length > 0) {
    const holders = [...new Set(subjectKeys.map((k) => graph.itemForKey(k)).filter((i): i is string => i !== null))];
    if (holders.length === 1) {
      const target = holders[0];
      const missing = [...subjectKeys.filter((k) => graph.itemForKey(k) !== target), threadKey];
      return { action: "join", itemId: target, addKeys: missing, merge: [], rule: "ref", promoted: false, kind, mentions: besides([...graph.keysOf(target), ...subjectKeys]) };
    }
    if (holders.length === 0 && kind !== "notification") {
      return { action: "create", keys: [...subjectKeys, threadKey], rule: "ref", kind, mentions };
    }
    // Held by two items, or a notification about something not yet tracked: left to the later rules
  }

  // 4. The message replies to, quotes or forwards one that belongs to an item
  for (const ref of message.refersTo ?? []) {
    const item = graph.itemForMessage(ref);
    if (item) {
      return { action: "join", itemId: item, addKeys: report ? [] : [threadKey], merge: [], rule: "reply", promoted: false, kind, mentions: besides(graph.keysOf(item)) };
    }
  }

  // Reports and noise stop here: the model isn't asked to place them
  const fallback = newItem(message, kind, named);
  if (kind === "report" || message.status === "noise") return fallback;
  return { action: "undecided", ambiguous: about.ambiguous, fallback, kind, mentions: named };
}
