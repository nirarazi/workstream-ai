// core/grouping/recognize.ts — What one message says, for grouping: deterministic recognizers only (docs/work-model.md §4)
//
// For each message: its kind (work, a report about many things, machine telemetry, or noise), the one key it's about
// (a ticket or PR it leads with, a subject a routine's tagged line names, or a release version a pipeline posts), the
// keys it only mentions, and whether it asks a question. Nothing here knows which platform or fleet it reads: tagged
// lines ("[drain] Northwind (…): …") are a common agent convention, read generically.

import { aboutRef, isReport, keyKind, refsByLine, type ResolverOptions, type SenderKind } from "../graph/resolver.js";
import type { StatusCategory } from "../types.js";

export interface GroupingMessage {
  /** The message's identity (an observation's dedupeKey, or the eval's message key) */
  key: string;
  threadId: string;
  channelId: string | null;
  senderId: string | null;
  senderKind: SenderKind;
  /** ISO 8601 */
  at: string;
  /** The sender's own lines (no quoted or forwarded text) */
  text: string;
  status?: StatusCategory | null;
  /** Flagged as a digest upstream */
  digest?: boolean;
  /** Posted on its own, not as a reply in a platform thread */
  topLevel?: boolean;
}

/** report: about many cases (a digest, a briefing); telemetry: machine output; chatter: about no case (a greeting, "are we up?") */
export type MessageKind = "work" | "report" | "telemetry" | "chatter";

export interface Recognized {
  kind: MessageKind;
  /** The one key it's about: "ticket:…", "pr:…", "subject:…" or "release:…" */
  about: string | null;
  /**
   * How it's known: from a ticket, PR or release the message leads with (key), a routine's tagged line (tagged), or a
   * subject the message only names, untagged (named), which is weaker evidence than a reply's thread
   */
  aboutBy: "key" | "tagged" | "named" | null;
  /** Keys it names but isn't about */
  mentions: string[];
  /** The routine lane a tagged line names ("drain"), if any */
  lane: string | null;
  /**
   * It asks for someone (blocked, a decision). An ask surfaces on its own, attached to its message, whatever the
   * grouping (docs/work-model.md, "Starting an item"), so a report carrying one joins no case but must still surface.
   */
  asks: boolean;
}

/** "[lane] Subject (detail): …" or "[lane] *Subject* — …": a routine's note about one subject */
const TAGGED_LINE = /^[\s*_]*\[([a-z][a-z0-9-]{1,30})\](.+)$/i;
/** Where a tagged line's subject ends */
const SUBJECT_END = /\(|:|\s[—–-]\s|,|\.\s|;/;
const NAME_JOINERS = new Set(["and", "&", "of", "de", "la", "van", "von", "der", "du", "da", "di", "y", "e"]);
/** Only the start of a first line is read for a tag and a subject */
const MAX_FIRST_LINE = 500;
const MAX_SUBJECT_WORDS = 6;

/** The subject a routine's tagged first line names, as a key: "subject:northwind", whatever its lane */
export function taggedSubject(firstLine: string): { lane: string; subject: string } | null {
  const m = TAGGED_LINE.exec(firstLine.slice(0, MAX_FIRST_LINE));
  if (!m) return null;
  const rest = m[2].replace(/[*_`]/g, "").trim();
  // Trailing punctuation isn't part of a name ("Tom Roupas Jr." is "Tom Roupas Jr")
  const name = rest.split(SUBJECT_END)[0].trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
  if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  const words = name.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_SUBJECT_WORDS || !/^[\p{Lu}\d$]/u.test(name) || COUNTED.test(name)) return null;
  // A name: capitalised words (and joining words), as "Northwind Traders" or "Rick Lee and Dana Ross"; or a short
  // phrase led by a code, as "SPRING26 offer". A sentence ("Dana said yes by email") isn't one.
  const capitalised = words.every((w) => /^[\p{Lu}\d&'$]/u.test(w) || NAME_JOINERS.has(w.toLowerCase()));
  const coded = words.length <= 3 && /^[\p{Lu}\d]{3,}$/u.test(words[0]) && /\d/.test(words[0]);
  if (!capitalised && !coded) return null;
  return { lane: m[1].toLowerCase(), subject: name.toLowerCase() };
}

/**
 * The record a message's first line links to, as a key: a URL whose query names a record ("…?record=a1b2c3d4",
 * "…&id=4471", "recordId="), as tools' alerts about a quote, an order or a lead do. "record:<host><path>#<id>".
 */
const RECORD_PARAM = /^(?:record|recordid|record_id|id|issue|ticket|order|quote)$/i;

export function recordKey(firstLine: string): string | null {
  for (const [, url] of firstLine.slice(0, MAX_FIRST_LINE).matchAll(/<?(https?:\/\/[^\s<>|]+)/g)) {
    let parsed: URL;
    try {
      parsed = new URL(url.replace(/&amp;/g, "&"));
    } catch {
      continue;
    }
    for (const [name, value] of parsed.searchParams) {
      if (RECORD_PARAM.test(name) && /^[\w-]{4,64}$/.test(value)) {
        return `record:${parsed.host.toLowerCase()}${parsed.pathname.toLowerCase()}#${value.toLowerCase()}`;
      }
    }
  }
  return null;
}

/** A release or build a pipeline posts about: a version with a release word near it */
const RELEASE_WORDS = /\b(?:release|tag|image|build|deploy(?:ed|ing|ment)?|rollout|rolled out)\b/i;
const VERSION = /\bv?(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?\b/i;

export function releaseKey(text: string, senderKind: SenderKind): string | null {
  if (senderKind === "human") return null;
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  if (!RELEASE_WORDS.test(first)) return null;
  const v = VERSION.exec(first);
  return v ? `release:${v[1]}` : null;
}

/**
 * A briefing or status post about many cases, by its header: "Mission status, Mon …", "Daily JIRA sync — …", "Night
 * shift summary", "Sprint planning complete", "Efficiency audit Oct 14", a "[daily-report]" tag. Read as the start of
 * the first line, so a sentence that only mentions a status doesn't count.
 */
const BRIEFING = new RegExp(
  String.raw`^[\W_]*(?:\[[a-z-]*(?:report|digest|summary|briefing|status)[a-z-]*\]|` +
    String.raw`(?:(?:daily|weekly|nightly|night[- ]shift|morning|evening|sprint|mission|efficiency|queue|dispatch)\b[^\n]{0,40}?\b` +
    String.raw`(?:status|sync|summary|plan|planning|wrap-up|digest|report|audit|reconciliation|verification|dispatch)\b))`,
  "i",
);
/** A briefing for the operator: "In priority order: 1. …", "Here's my list, most urgent first" */
const PRIORITY_LIST = /\b(?:in priority order|most urgent first|top \d+ things)\b/i;
/** A tagged line whose subject is a count of things ("Five items", "Three follow-ups checked"): many subjects, not one */
const COUNTED = /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|all)\s+\S+/i;
/** Health and liveness: "All green ✓ Gateway: running …", "HEARTBEAT_OK", "nothing needs a Slack post" */
const HEALTH = /^[\W_]*all green\b|\bHEARTBEAT_OK\b|\bnothing needs a slack post\b/i;
/** A person checking on the fleet or greeting it, in a few words: "OK are we still alive?", "How are you", "Are you down?" */
const CHATTER = /^[\W_]*(?:(?:ok|so|hey|hi)[,!]?\s+)?(?:are (?:we|you|they)(?: all)? (?:still )?(?:alive|up|down|there|ok|running|healthy)|how are you|good (?:morning|night)|thanks?(?: you)?|thx)\b[^\n]{0,40}$/i;

/** Machine output: key=value lines, tick markers, idle heartbeats, a sweep's "no change since the last check" */
const TELEMETRY = [
  /^[\W_]*(?:\d{1,2}:\d{2}\s*(?:UTC|[AP]M)?[^.\n]{0,40}\.\s*)?(?:no (?:new )?changes?|nothing (?:has )?changed|nothing new)(?:\s+since\b|\s*[.!:]|\s*$)/i,
  /^[A-Z][A-Z0-9_]*=\S+(?:\s+[a-z_]+=\S+)*\s*$/,
  /^[A-Z][A-Z0-9_]{2,}(?:\s+[a-z_]+=\S+){2,}/,
  /^[\W_]*(?:quiet cycle|all (?:pending )?items (?:are )?unchanged)\b/i,
  /\bheartbeat tick\b/i,
  /^[\s:\w]*\bIdle since\b/i,
];

/**
 * Emphasis marks at a word's edge ("_OPS-101 nudge_", "*Northwind*") hide keys from word-boundary patterns; ones
 * inside a word or a URL (repo_name) are kept.
 */
export function stripEmphasis(text: string): string {
  // Linear: a run of marks is matched once, from its start, whatever follows it
  return text.replace(/(?<![\w/_*~])[_*~]+|(?<![_*~])[_*~]+(?![\w/_*~])/g, " ");
}

/**
 * Known subject names, indexed by first word, with their patterns: built once per grouping run (no state is kept
 * between runs), so a message is tested only against subjects whose first word it contains.
 */
export class SubjectLexicon {
  private byFirstWord = new Map<string, Array<{ name: string; re: RegExp }>>();

  constructor(names: Iterable<string>) {
    for (const name of names) {
      const first = name.split(" ")[0];
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      this.byFirstWord.set(first, [...(this.byFirstWord.get(first) ?? []), { name, re }]);
    }
  }

  get size(): number {
    return this.byFirstWord.size;
  }

  /** The known subjects a (lower-cased, normalised) text names */
  found(head: string): string[] {
    const words = new Set(head.split(/[^\p{L}\p{N}/'&$-]+/u).filter(Boolean));
    const out: string[] = [];
    for (const w of words) for (const s of this.byFirstWord.get(w) ?? []) if (s.re.test(head)) out.push(s.name);
    return out;
  }
}

/** The one known subject a message names near its start, as a whole phrase, or null for none or several */
function namedSubject(text: string, subjects: SubjectLexicon): string | null {
  const head = stripEmphasis(text.slice(0, 300)).toLowerCase().replace(/\s+/g, " ");
  const found = subjects.found(head);
  // A longer name containing a shorter one ("dana lee" and "lee") is one subject
  const distinct = found.filter((s) => !found.some((o) => o !== s && o.includes(s)));
  return distinct.length === 1 ? distinct[0] : null;
}

/** A sign-off a tool adds ("*Sent using* @Composer"): never stored or read as content (docs/work-model.md §4) */
const SIGNATURE = /^\s*[*_]*sent (?:using|from|with)[*_]*\s+(?:<@[^<>\s]+>|\S+)\s*$/gim;

export function recognize(message: GroupingMessage, options: ResolverOptions & { subjects?: SubjectLexicon }): Recognized {
  const own = message.text.replace(SIGNATURE, "").trim();
  if (!own) return { kind: "chatter", about: null, aboutBy: null, mentions: [], lane: null, asks: false };
  const lines = refsByLine(stripEmphasis(own), options);
  const about = aboutRef(lines);
  const refs = [...new Set(lines.flatMap((l) => l.refs))];
  const firstLine = own.split("\n").find((l) => l.trim())?.trim() ?? "";
  const tagged = message.senderKind !== "human" ? taggedSubject(firstLine) : null;
  // The classifier's "noise" decides what surfaces, never what a message belongs to (docs/work-model.md, §3): a short
  // "yes" or "you merge" it calls noise is still a step in a case, so status isn't read here except for asks
  // An ask is never set aside as telemetry, and a report carrying one says so (asks), so it surfaces on its own
  const asks = message.status === "blocked_on_human" || message.status === "needs_decision";
  const head = firstLine.slice(0, MAX_FIRST_LINE);
  const machine = message.senderKind !== "human";
  const telemetry = machine && !asks && (TELEMETRY.some((re) => re.test(head)) || HEALTH.test(head));
  // Anyone's: a briefing is told by its header, which people rarely start a message with otherwise (and an agent posting
  // under a person's account reads as a person)
  const briefing = !tagged && (BRIEFING.test(head) || PRIORITY_LIST.test(own.slice(0, MAX_FIRST_LINE)));
  const chatter = !asks && own.trim().length <= 80 && CHATTER.test(own.trim());
  const report = briefing || (!tagged && isReport(
    { threadId: message.threadId, senderKind: message.senderKind, text: own, status: message.status ?? null, priorInThread: 0, digest: message.digest },
    lines, [], about.subject,
  ));
  const kind: MessageKind = telemetry ? "telemetry" : report ? "report" : chatter ? "chatter" : "work";

  const named = !tagged && options.subjects?.size ? namedSubject(own, options.subjects) : null;
  const subjectKey = tagged ? `subject:${tagged.subject}` : named ? `subject:${named}` : null;
  const release = releaseKey(own, message.senderKind);
  const record = about.subject || subjectKey || release ? null : recordKey(firstLine);
  const aboutKey = about.subject ?? subjectKey ?? release ?? record;
  const aboutBy = about.subject || (!subjectKey && (release || record)) ? "key" : tagged ? "tagged" : named ? "named" : null;
  const mentions = refs.filter((r) => r !== aboutKey && keyKind(r) !== "subject");
  const work = kind === "work";
  return { kind, about: work ? aboutKey : null, aboutBy: work && aboutKey ? aboutBy : null, mentions, lane: tagged?.lane ?? null, asks };
}
