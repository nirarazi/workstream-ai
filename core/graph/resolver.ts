// core/graph/resolver.ts — Decides which work item a message belongs to, by deterministic rules only
//
// A work item is a deliverable: a ticket, a PR, a case for one subject, or a conversation that asks for something.
// Its identity is a set of keys ("ticket:OPS-101", "pr:forge.example/org/repo#7", "thread:<thread id>",
// "subject:<lane>:<subject>", "mcp:<agent-supplied id>"), and a message resolves to an item by looking its keys up.
//
// The rules, tried in order (the first that decides wins):
//   1. mcp     an agent pushed the message over MCP with a work item id: that id
//   2. thread  the message's thread already belongs to an item. If that item has only thread keys and the sender's
//              own lines lead with the one ticket, PR or subject they're about, the item gains that key (or merges
//              into the item that already holds it: "promotion")
//   3. ref     the sender's own lines are about exactly one ticket, PR or subject
//   4. reply   the platform says the message replies to, quotes or forwards a message that belongs to an item
//   (5.        the model chooses among candidates: not here. The resolver says "undecided" and what rule 6 would do)
//   6. new     a message that asks for something, or a conversation with replies, starts an item keyed by its
//              thread. A lone progress or completion note with no key is activity, not an item.
//
// Reports (digests, heartbeats, roundups) and notifications never create an item and never link two items: the
// tickets they name are mentions, i.e. updates to those tickets' items. A thread a report started is never claimed by
// one of its replies either, so a digest's thread doesn't gather unrelated work. A ticket named after "blocked by",
// "related to" and the like is a mention, never what the message is about. No model is called, nothing is written,
// and nothing here knows which messaging platform a message came from: thread ids and message refs are opaque.

import type { StatusCategory } from "../types.js";
import { DIGEST_MIN_ITEMS } from "./linker.js";
import { ownLines } from "./own-lines.js";

export type KeyKind = "ticket" | "pr" | "subject" | "thread" | "message" | "mcp";

/** A work item key as a string: "<kind>:<value>" */
export type ItemKey = string;

export function itemKey(kind: KeyKind, value: string): ItemKey {
  return `${kind}:${value}`;
}

export function keyKind(key: ItemKey): KeyKind {
  return key.slice(0, key.indexOf(":")) as KeyKind;
}

function keyValue(key: ItemKey): string {
  return key.slice(key.indexOf(":") + 1);
}

export type SenderKind = "agent" | "human" | "notification" | "unknown";

/** What a message is, decided before any linking */
export type MessageKind = "work" | "report" | "notification";

export interface ResolverMessage {
  threadId: string;
  /** An opaque ref of the message itself, which keys an ask made inside a report's thread */
  messageRef?: string;
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
  /** How many earlier messages of this thread were work (not reports, not noise) */
  priorInThread: number;
  /** The thread was started by a report (or a report in it belongs to no item): no reply may claim the thread */
  inReportThread?: boolean;
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

/** Which report heuristic fired */
export type ReportSignal = "digest-flag" | "many-refs" | "list" | "no-change" | "header";

export type Resolution =
  /** Belongs to `itemId`, which gains `addKeys`. Items in `merge` fold into it (they held nothing it conflicts with). */
  | { action: "join"; itemId: string; addKeys: ItemKey[]; merge: string[]; rule: ResolvedBy; promoted: boolean; kind: MessageKind; report: ReportSignal | null; mentions: ItemKey[] }
  /** Starts a new item holding `keys` */
  | { action: "create"; keys: ItemKey[]; rule: ResolvedBy; kind: MessageKind; report: ReportSignal | null; mentions: ItemKey[] }
  /** Belongs to no item: a report, a notification or a note with nothing to attach to, or noise */
  | { action: "none"; reason: "report" | "notification" | "activity" | "noise"; kind: MessageKind; report: ReportSignal | null; mentions: ItemKey[] }
  /**
   * Rules 1–4 didn't decide. The model may choose an existing item; otherwise `fallback` (rule 6) applies.
   * `ambiguous`: the message names several tickets or PRs with none of them as its subject.
   */
  | { action: "undecided"; ambiguous: boolean; fallback: Resolution; kind: MessageKind; report: ReportSignal | null; mentions: ItemKey[] };

// --- Refs: what a message names in its sender's own lines ---------------------------------------------------------

/** Lines longer than this are cut before any pattern runs on them, which bounds the work a message can cause */
export const MAX_LINE_CHARS = 2000;

/** Forge pull/merge request URLs: https://host/org/repo/pull/7, https://host/group/repo/-/merge_requests/7 */
const PR_URL = /https?:\/\/([^\s/|>]+)\/((?:[^\s/|>]+\/){1,8}?)(?:-\/)?(?:pull|pulls|merge_requests)\/(\d+)/gi;

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

/** Words before a ticket that make it a dependency or an aside, not what the message is about */
const DEPENDENCY_BEFORE =
  /(?:blocked (?:by|on)|waiting (?:on|for)|waits on|depends on|dependent on|unrelated to|dupe of|duplicate of|duplicates|see also|related to|relates to)[\s:*_`]*$/i;

export interface LineRefs {
  line: string;
  refs: ItemKey[];
  /** Refs in this line named after a dependency word ("blocked by OPS-101"): mentions only */
  asides: ItemKey[];
}

/** Where a ticket key stands in a line, as a whole key: OPS-10 isn't found inside OPS-101 */
function ticketAt(line: string, ticket: string): number {
  const escaped = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![0-9])`).exec(line)?.index ?? -1;
}

export function refsByLine(text: string, options: ResolverOptions): LineRefs[] {
  return text.split("\n").map((full) => {
    const line = full.slice(0, MAX_LINE_CHARS);
    const tickets = options.extractTickets(line);
    const refs = [...tickets.map((t) => itemKey("ticket", t)), ...extractPullRequests(line).map((p) => itemKey("pr", p))];
    const asides = tickets
      .filter((t) => {
        const at = ticketAt(line, t);
        return at >= 0 && DEPENDENCY_BEFORE.test(line.slice(Math.max(0, at - 40), at));
      })
      .map((t) => itemKey("ticket", t));
    return { line, refs, asides };
  });
}

const compiledRules = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = compiledRules.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    compiledRules.set(pattern, re);
  }
  return re;
}

/** The subject key a configured rule finds in the message's first own line, if any */
export function subjectKey(message: ResolverMessage, own: string, rules: SubjectRule[] | undefined): ItemKey | null {
  if (!rules?.length) return null;
  const first = (own.split("\n").find((l) => l.trim())?.trim() ?? "").slice(0, MAX_LINE_CHARS);
  for (const rule of rules) {
    if (rule.sender && rule.sender !== message.senderId) continue;
    if (rule.channel && rule.channel !== message.channelId) continue;
    const m = compiled(rule.pattern).exec(first);
    const subject = m?.groups?.subject?.trim().toLowerCase();
    if (!subject) continue;
    const lane = m?.groups?.lane?.trim().toLowerCase() ?? "";
    return itemKey("subject", `${lane}:${subject.replace(/\s+/g, " ")}`);
  }
  return null;
}

/** A ticket leads its line when fewer than this many words come before it ("Done OPS-101 —", "Started work on OPS-101:") */
const LEAD_WORDS = 4;

export interface About {
  /** The ticket, PR or subject the message is about */
  subject: ItemKey | null;
  /** Keys that go with the subject: a PR named on the same line as its one ticket */
  extra: ItemKey[];
  /** The subject leads the first own line with refs (strong enough to re-key or merge an item) */
  leads: boolean;
  /** Several are named, none as the subject */
  ambiguous: boolean;
}

/** The ticket a line leads with: the first one, fewer than LEAD_WORDS words in, not paired with the next ("OPS-101 and ENG-202") */
function leadTicket(l: LineRefs): ItemKey | null {
  if (LIST_LINE.test(l.line)) return null;
  const line = l.line.trim();
  const placed = [...new Set(l.refs)]
    .filter((k) => keyKind(k) === "ticket")
    .map((k) => ({ key: k, at: ticketAt(line, keyValue(k)) }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at);
  const lead = placed[0];
  if (!lead || l.asides.includes(lead.key)) return null;
  if (line.slice(0, lead.at).split(/\s+/).filter((w) => /\w/.test(w)).length >= LEAD_WORDS) return null;
  const next = placed[1];
  if (!next) return lead.key;
  const between = line.slice(lead.at + keyValue(lead.key).length, next.at).trim();
  return /^(?:,|and|&|\+|\/|or)?$/i.test(between) ? null : lead.key;
}

/**
 * The one ticket or PR a message is about, among those its own lines name (dependencies and asides aside):
 * - the only one, or a ticket and the one PR named on its line;
 * - otherwise the ticket the first own line with refs leads with.
 * The rest are mentions. `leads` says whether the subject leads that line, which promotion needs.
 */
export function aboutRef(lines: LineRefs[]): About {
  const candidates = [...new Set(lines.flatMap((l) => l.refs.filter((r) => !l.asides.includes(r))))];
  if (candidates.length === 0) return { subject: null, extra: [], leads: false, ambiguous: false };
  // The first own line that names something it's about, skipping lines of asides only
  const leadLine = lines.find((l) => l.refs.some((r) => !l.asides.includes(r)));
  const led = leadLine ? leadTicket(leadLine) : null;

  if (candidates.length === 1) {
    const only = candidates[0];
    const leads = keyKind(only) === "ticket" ? led === only : !!leadLine && !LIST_LINE.test(leadLine.line);
    return { subject: only, extra: [], leads, ambiguous: false };
  }
  const tickets = candidates.filter((k) => keyKind(k) === "ticket");
  const prs = candidates.filter((k) => keyKind(k) === "pr");
  if (tickets.length === 1 && prs.length === 1 && lines.some((l) => l.refs.includes(tickets[0]) && l.refs.includes(prs[0]))) {
    return { subject: tickets[0], extra: prs, leads: led === tickets[0], ambiguous: false };
  }
  if (led) return { subject: led, extra: [], leads: true, ambiguous: false };
  return { subject: null, extra: [], leads: false, ambiguous: true };
}

// --- Report detection ---------------------------------------------------------------------------------------------

/** Decoration a header may start with: markdown marks and :emoji: */
const HEADER_LEAD = String.raw`^[\s*_#~` + "`" + String.raw`]*(?::[\w+-]+:[\s*_#~` + "`" + String.raw`]*)*`;
const QUALIFIER = "(?:daily|weekly|nightly|night|evening|shift|sprint|queue|fleet)";

/** A header that is a report by itself: "Daily digest", "*Night summary*", "Heartbeat:", "Status report" */
const STRONG_HEADER = new RegExp(
  HEADER_LEAD + String.raw`(?:(?:${QUALIFIER}\s+)?(?:digest|roundup|round-up|heartbeat|status report)|${QUALIFIER}\s+(?:summary|recap|stand-?up))\b`,
  "i",
);
/**
 * A header that is a report only over several items: "Summary:", "Weekly sync", "Sprint plan", "Shift update". An
 * update or plan needs its qualifier ("Plan: finish OPS-101, then OPS-102" is one agent's work), and the header has to
 * end there ("Update on OPS-101 and ENG-202" is news about those two).
 */
const WEAK_HEADER = new RegExp(
  HEADER_LEAD +
    String.raw`(?:(?:${QUALIFIER}\s+)?(?:summary|recap|stand-?up|sync|status|audit|report)|${QUALIFIER}\s+(?:update|plan))` +
    String.raw`[\s*_~` + "`" + String.raw`]*(?:[:—–-]|$)`,
  "i",
);

/**
 * A no-change tick, as the whole of its first line: "Nothing has changed since the last check", "No updates.",
 * "Idle since 09:00". Not when the line goes on to a reason, a failure or a request.
 */
const NO_CHANGE = new RegExp(
  HEADER_LEAD +
    String.raw`(?:nothing (?:has )?changed|no (?:new )?changes|no updates?|(?:still )?idle)\b` +
    String.raw`(?![^\n]*\b(?:because|but|however|though|although|except|failed|fails|failing|error|errors|down|broke|broken|blocked|need|needs|please|should|could|can)\b)` +
    String.raw`[^?\n]{0,80}$`,
  "i",
);

/** A message whose status asks for someone, or reports work done, is never a tick or a header-only report */
function newsStatus(status: StatusCategory | null | undefined): boolean {
  return status === "blocked_on_human" || status === "needs_decision" || status === "completed";
}

/**
 * Whether a message is a report, and which heuristic says so:
 * - digest-flag: the pipeline already flagged it a digest;
 * - many-refs: it names DIGEST_MIN_ITEMS or more items (a PR counts only on a line naming no ticket);
 * - list: two or more list lines carrying two or more tickets other than the one it leads with;
 * - no-change: a short (one or two lines) "nothing changed since …" naming nothing besides the thread's own item;
 * - header: a report header (a weak one needs two or more items named).
 * The last two never apply to a blocker, a decision or a completion: those are news, whatever their first words.
 * Humans' messages never are (the pipeline treats them the same way). `ownKeys` are the keys of the thread's own
 * item: a reply in a ticket's thread naming it isn't a digest.
 */
export function isReport(message: ResolverMessage, lines: LineRefs[], ownKeys: readonly ItemKey[] = [], lead: ItemKey | null = null): ReportSignal | null {
  if (message.senderKind === "human") return null;
  if (message.digest) return "digest-flag";
  const own = new Set(ownKeys);
  const named = new Set<ItemKey>();
  for (const l of lines) {
    const hasTicket = l.refs.some((r) => keyKind(r) === "ticket");
    for (const r of l.refs) if (!own.has(r) && (keyKind(r) === "ticket" || !hasTicket)) named.add(r);
  }
  if (named.size >= DIGEST_MIN_ITEMS) return "many-refs";

  const listed = new Set<ItemKey>();
  let listLines = 0;
  for (const l of lines) {
    if (!LIST_LINE.test(l.line)) continue;
    const tickets = l.refs.filter((r) => keyKind(r) === "ticket" && !own.has(r) && r !== lead);
    if (tickets.length === 0) continue;
    listLines++;
    for (const r of tickets) listed.add(r);
  }
  if (listLines >= 2 && listed.size >= 2) return "list";

  if (newsStatus(message.status)) return null;
  const nonEmpty = lines.filter((l) => l.line.trim());
  const first = nonEmpty[0]?.line.trim() ?? "";
  if (nonEmpty.length <= 2 && named.size === 0 && NO_CHANGE.test(first)) return "no-change";
  if (STRONG_HEADER.test(first) && named.size !== 1) return "header";
  if (WEAK_HEADER.test(first) && named.size >= 2) return "header";
  return null;
}

// --- The resolver -------------------------------------------------------------------------------------------------

function asks(status: StatusCategory | null | undefined): boolean {
  return status === "blocked_on_human" || status === "needs_decision";
}

/** Rule 6: what a message nothing else placed becomes */
function newItem(message: ResolverMessage, kind: MessageKind, report: ReportSignal | null, mentions: ItemKey[]): Resolution {
  if (kind === "report") return { action: "none", reason: "report", kind, report, mentions };
  if (message.status === "noise") return { action: "none", reason: "noise", kind, report, mentions };
  if (kind === "notification") return { action: "none", reason: "notification", kind, report, mentions };
  if (message.inReportThread) {
    // A report's thread is never claimed: an ask, or a person's message, in it is an item of its own (never lose an
    // ask); anything else is activity
    return (asks(message.status) || message.senderKind === "human") && message.messageRef
      ? { action: "create", keys: [itemKey("message", message.messageRef)], rule: "new", kind, report, mentions }
      : { action: "none", reason: "activity", kind, report, mentions };
  }
  // An ask, a person's message, or a conversation (it has replies) is something to follow
  if (asks(message.status) || message.senderKind === "human" || message.priorInThread > 0) {
    return { action: "create", keys: [itemKey("thread", message.threadId)], rule: "new", kind, report, mentions };
  }
  // A lone progress or completion note with no key: activity, not a deliverable
  return { action: "none", reason: "activity", kind, report, mentions };
}

export function resolve(message: ResolverMessage, graph: ResolverGraph, options: ResolverOptions): Resolution {
  const threadKey = itemKey("thread", message.threadId);
  /** The thread key, unless a report started the thread: a reply there never claims it */
  const claim = message.inReportThread ? [] : [threadKey];
  const own = ownLines(message.text);
  const lines = refsByLine(own, options);
  const threadItem = graph.itemForKey(threadKey);
  const threadItemKeys = threadItem ? graph.keysOf(threadItem) : [];

  const about = aboutRef(lines);
  const report = isReport(message, lines, threadItemKeys, about.leads ? about.subject : null);
  const kind: MessageKind = report ? "report" : message.senderKind === "notification" ? "notification" : "work";
  const subject = report ? null : about.subject ?? subjectKey(message, own, options.subjectRules);
  const subjectKeys = subject ? [subject, ...(subject === about.subject ? about.extra : [])] : [];
  // A configured subject rule matches the first line, so it leads by construction
  const leads = !!subject && (subject !== about.subject || about.leads);
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
      ? { action: "join", itemId: held, addKeys: [], merge: [], rule: "mcp", promoted: false, kind, report, mentions: besides(graph.keysOf(held)) }
      : { action: "create", keys: [key], rule: "mcp", kind, report, mentions: besides([key]) };
  }

  // 2. Thread membership, with promotion of a thread-only item to the key its message leads with
  if (threadItem) {
    const threadOnly = threadItemKeys.every((k) => keyKind(k) === "thread");
    if (kind !== "report" && threadOnly && leads) {
      const holders = [...new Set(subjectKeys.map((k) => graph.itemForKey(k)).filter((i): i is string => i !== null && i !== threadItem))];
      if (holders.length === 1) {
        // The key's item absorbs the thread's: it gains the thread's keys and any of these it lacks
        const target = holders[0];
        const missing = subjectKeys.filter((k) => graph.itemForKey(k) !== target);
        return { action: "join", itemId: target, addKeys: missing, merge: [threadItem], rule: "thread", promoted: true, kind, report, mentions: besides([...graph.keysOf(target), ...subjectKeys]) };
      }
      if (holders.length === 0) {
        return { action: "join", itemId: threadItem, addKeys: subjectKeys, merge: [], rule: "thread", promoted: true, kind, report, mentions };
      }
      // The ticket and its PR are held by two different items: not this rule's call to merge them
    }
    return { action: "join", itemId: threadItem, addKeys: [], merge: [], rule: "thread", promoted: false, kind, report, mentions: besides(threadItemKeys) };
  }

  // 3. The one ticket, PR or subject the sender's own lines are about (never a report's)
  if (subjectKeys.length > 0) {
    const holders = [...new Set(subjectKeys.map((k) => graph.itemForKey(k)).filter((i): i is string => i !== null))];
    if (holders.length === 1) {
      const target = holders[0];
      const missing = [...subjectKeys.filter((k) => graph.itemForKey(k) !== target), ...claim];
      return { action: "join", itemId: target, addKeys: missing, merge: [], rule: "ref", promoted: false, kind, report, mentions: besides([...graph.keysOf(target), ...subjectKeys]) };
    }
    if (holders.length === 0 && kind !== "notification") {
      return { action: "create", keys: [...subjectKeys, ...claim], rule: "ref", kind, report, mentions };
    }
    // Held by two items, or a notification about something not yet tracked: left to the later rules
  }

  // 4. The message replies to, quotes or forwards one that belongs to an item
  for (const ref of message.refersTo ?? []) {
    const item = graph.itemForMessage(ref);
    if (item) {
      return { action: "join", itemId: item, addKeys: report ? [] : claim, merge: [], rule: "reply", promoted: false, kind, report, mentions: besides(graph.keysOf(item)) };
    }
  }

  // Reports and noise stop here: the model isn't asked to place them
  const fallback = newItem(message, kind, report, named);
  if (kind === "report" || message.status === "noise") return fallback;
  return { action: "undecided", ambiguous: about.ambiguous, fallback, kind, report, mentions: named };
}
