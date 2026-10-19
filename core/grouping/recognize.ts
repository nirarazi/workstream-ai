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
/** Only the start of a first line is read for a tag and a subject */
const MAX_FIRST_LINE = 500;
const MAX_SUBJECT_WORDS = 6;

/** The subject a routine's tagged first line names, as a key: "subject:northwind", whatever its lane */
export function taggedSubject(firstLine: string): { lane: string; subject: string } | null {
  const m = TAGGED_LINE.exec(firstLine.slice(0, MAX_FIRST_LINE));
  if (!m) return null;
  const rest = m[2].replace(/[*_`]/g, "").trim();
  const name = rest.split(SUBJECT_END)[0].trim().replace(/\s+/g, " ");
  const words = name.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_SUBJECT_WORDS || !/^[\p{Lu}\d$]/u.test(name) || COUNTED.test(name)) return null;
  return { lane: m[1].toLowerCase(), subject: name.toLowerCase() };
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

/** Machine output: key=value lines, tick markers, idle heartbeats */
const TELEMETRY = [
  /^[A-Z][A-Z0-9_]*=\S+(?:\s+[a-z_]+=\S+)*\s*$/,
  /^[A-Z][A-Z0-9_]{2,}(?:\s+[a-z_]+=\S+)+\s*$/,
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

const subjectPatterns = new Map<string, RegExp>();
function subjectPattern(subject: string): RegExp {
  let re = subjectPatterns.get(subject);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    subjectPatterns.set(subject, re);
  }
  return re;
}

/** The one known subject a message names near its start, as a whole phrase, or null for none or several */
function namedSubject(text: string, subjects: readonly string[]): string | null {
  const head = stripEmphasis(text.slice(0, 300)).toLowerCase().replace(/\s+/g, " ");
  const found = subjects.filter((s) => subjectPattern(s).test(head));
  // A longer name containing a shorter one ("dana lee" and "lee") is one subject
  const distinct = found.filter((s) => !found.some((o) => o !== s && o.includes(s)));
  return distinct.length === 1 ? distinct[0] : null;
}

export function recognize(message: GroupingMessage, options: ResolverOptions & { subjects?: readonly string[] }): Recognized {
  const own = message.text;
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

  const named = !tagged && options.subjects?.length ? namedSubject(own, options.subjects) : null;
  const subjectKey = tagged ? `subject:${tagged.subject}` : named ? `subject:${named}` : null;
  const aboutKey = about.subject ?? subjectKey ?? releaseKey(own, message.senderKind);
  const mentions = refs.filter((r) => r !== aboutKey && keyKind(r) !== "subject");
  return { kind, about: kind === "work" ? aboutKey : null, mentions, lane: tagged?.lane ?? null, asks };
}
