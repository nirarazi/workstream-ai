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
}

export type MessageKind = "work" | "report" | "telemetry" | "noise";

export interface Recognized {
  kind: MessageKind;
  /** The one key it's about: "ticket:…", "pr:…", "subject:…" or "release:…" */
  about: string | null;
  /** Keys it names but isn't about */
  mentions: string[];
  /** The routine lane a tagged line names ("drain"), if any */
  lane: string | null;
  question: boolean;
}

/** "[lane] Subject (detail): …" or "[lane] *Subject* — …": a routine's note about one subject */
const TAGGED_LINE = /^[\s*_]*\[([a-z][a-z0-9-]{1,30})\][\s*_]*(.+)$/i;
/** Where a tagged line's subject ends */
const SUBJECT_END = /\s*(?:\(|:|\s[—–-]\s|,|\.\s|;)/;
const MAX_SUBJECT_WORDS = 6;

/** The subject a routine's tagged first line names, as a key: "subject:northwind", whatever its lane */
export function taggedSubject(firstLine: string): { lane: string; subject: string } | null {
  const m = TAGGED_LINE.exec(firstLine);
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
  /\bheartbeat tick\b/i,
  /^[\s:\w]*\bIdle since\b/i,
];

/**
 * Emphasis marks at a word's edge ("_OPS-101 nudge_", "*Northwind*") hide keys from word-boundary patterns; ones
 * inside a word or a URL (repo_name) are kept.
 */
export function stripEmphasis(text: string): string {
  return text.replace(/(?<![\w/])[_*~]+|[_*~]+(?![\w/])/g, " ");
}

export function recognize(message: GroupingMessage, options: ResolverOptions): Recognized {
  const own = message.text;
  const lines = refsByLine(stripEmphasis(own), options);
  const about = aboutRef(lines);
  const refs = [...new Set(lines.flatMap((l) => l.refs))];
  const firstLine = own.split("\n").find((l) => l.trim())?.trim() ?? "";
  const tagged = message.senderKind !== "human" ? taggedSubject(firstLine) : null;
  const question = /\?\s*$/.test(own.trim()) || /\?\s*\n/.test(own);

  // The classifier's "noise" decides what surfaces, never what a message belongs to (docs/work-model.md, §3): a short
  // "yes" or "you merge" it calls noise is still a step in a case
  const noise = false;
  const telemetry = message.senderKind !== "human" && TELEMETRY.some((re) => re.test(firstLine));
  const report = !tagged && isReport(
    { threadId: message.threadId, senderKind: message.senderKind, text: own, status: message.status ?? null, priorInThread: 0, digest: message.digest },
    lines, [], about.subject,
  );
  const kind: MessageKind = telemetry ? "telemetry" : report ? "report" : noise ? "noise" : "work";

  const subjectKey = tagged ? `subject:${tagged.subject}` : null;
  const aboutKey = about.subject ?? subjectKey ?? releaseKey(own, message.senderKind);
  const mentions = refs.filter((r) => r !== aboutKey && keyKind(r) !== "subject");
  return { kind, about: kind === "work" ? aboutKey : null, mentions, lane: tagged?.lane ?? null, question };
}
