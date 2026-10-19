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

export type MessageKind = "work" | "report" | "telemetry";

export interface Recognized {
  kind: MessageKind;
  /** The one key it's about: "ticket:…", "pr:…", "subject:…" or "release:…" */
  about: string | null;
  /** Keys it names but isn't about */
  mentions: string[];
  /** The routine lane a tagged line names ("drain"), if any */
  lane: string | null;
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
  if (words.length === 0 || words.length > MAX_SUBJECT_WORDS || !/^[\p{Lu}\d$]/u.test(name)) return null;
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
  // A message that asks for someone is never set aside as telemetry or a report: the ask must not be lost
  const asks = message.status === "blocked_on_human" || message.status === "needs_decision";
  const telemetry = message.senderKind !== "human" && !asks && TELEMETRY.some((re) => re.test(firstLine.slice(0, MAX_FIRST_LINE)));
  const report = !tagged && !asks && isReport(
    { threadId: message.threadId, senderKind: message.senderKind, text: own, status: message.status ?? null, priorInThread: 0, digest: message.digest },
    lines, [], about.subject,
  );
  const kind: MessageKind = telemetry ? "telemetry" : report ? "report" : "work";

  const named = !tagged && options.subjects?.length ? namedSubject(own, options.subjects) : null;
  const subjectKey = tagged ? `subject:${tagged.subject}` : named ? `subject:${named}` : null;
  const aboutKey = about.subject ?? subjectKey ?? releaseKey(own, message.senderKind);
  const mentions = refs.filter((r) => r !== aboutKey && keyKind(r) !== "subject");
  return { kind, about: kind === "work" ? aboutKey : null, mentions, lane: tagged?.lane ?? null };
}
