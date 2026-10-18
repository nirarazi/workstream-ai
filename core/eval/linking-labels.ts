// core/eval/linking-labels.ts — The operator's verdicts on message grouping (eval-data/linking/labels.json)
//
// Labels are keyed by a message's platform identity ("<platform>:<channel id>:<message id>", see messageKey in
// linking-data.ts), not by events.id: an event row's id is a random UUID that changes when messages are re-ingested
// or relinked, while the platform's id doesn't, so one set of verdicts scores the current grouping, the re-link
// proposal and any later one. The file names its key format, so a change to it is a new format version. Two kinds
// of label: a pair verdict (same work or different work) and a "not work" mark on a single message. The file holds
// message keys and the operator's notes, so it lives in eval-data/ (gitignored), in a private directory, written as a
// private file.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareOutDir, writePrivateFile } from "../graph/relink.js";

/** The file format's version. Bump it when the shape or key format changes, and teach loadLabels to read the older one. */
export const LABELS_VERSION = 1;
/** How messages are keyed in this version (the future observation dedupeKey) */
export const KEY_FORMAT = "<platform>:<channel id>:<message id>";
export const LINKING_DIR = join("eval-data", "linking");
const LABELS_FILE = "labels.json";

export type PairVerdict = "same" | "different";

export interface PairLabel {
  /** Message keys of the two messages, a < b */
  a: string;
  b: string;
  verdict: PairVerdict;
  note?: string;
  labeledAt: string;
  /** The stratum the pair was drawn from, for the per-stratum breakdown */
  stratum?: string;
}

export interface NotWorkLabel {
  /** Message key of a message that isn't work: it shouldn't be in any work item */
  message: string;
  labeledAt: string;
  note?: string;
}

export interface LinkingLabels {
  version: typeof LABELS_VERSION;
  /** Always KEY_FORMAT: says what the message keys below are */
  keyFormat: typeof KEY_FORMAT;
  pairs: PairLabel[];
  notWork: NotWorkLabel[];
}

export function emptyLabels(): LinkingLabels {
  return { version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: [], notWork: [] };
}

/** The order-free key of a pair */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function labelsPath(root: string): string {
  return join(root, LINKING_DIR, LABELS_FILE);
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

/** Parses and checks a labels file's content. A newer or unknown version or key format is an error, never misread. */
export function parseLabels(content: string): LinkingLabels {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Linking labels: the file isn't valid JSON");
  }
  const data = raw as Partial<LinkingLabels> | null;
  if (!data || typeof data !== "object" || typeof data.version !== "number") {
    throw new Error("Linking labels: no format version in the file");
  }
  if (data.version > LABELS_VERSION) {
    throw new Error(`Linking labels: the file is format version ${data.version}, newer than this code reads (${LABELS_VERSION})`);
  }
  if (data.version !== LABELS_VERSION) throw new Error(`Linking labels: unsupported format version ${data.version}`);
  if (data.keyFormat !== KEY_FORMAT) throw new Error("Linking labels: the file's message key format isn't this version's");
  if (!Array.isArray(data.pairs) || !Array.isArray(data.notWork)) throw new Error("Linking labels: expected pairs and notWork lists");
  data.pairs.forEach((p, i) => {
    if (!isString(p?.a) || !isString(p?.b) || p.a === p.b || (p.verdict !== "same" && p.verdict !== "different")
      || !isString(p.labeledAt) || !optionalString(p.note) || !optionalString(p.stratum)) {
      throw new Error(`Linking labels: pair ${i + 1} is malformed`);
    }
  });
  data.notWork.forEach((n, i) => {
    if (!isString(n?.message) || !isString(n.labeledAt) || !optionalString(n.note)) throw new Error(`Linking labels: not-work label ${i + 1} is malformed`);
  });
  return { version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: data.pairs, notWork: data.notWork };
}

/** The labels under <root>/eval-data/linking/, or none yet. A symlinked file is refused. */
export function loadLabels(root: string): LinkingLabels {
  const path = labelsPath(root);
  if (!existsSync(path)) return emptyLabels();
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to read: ${path} is a symlink`);
  return parseLabels(readFileSync(path, "utf-8"));
}

/** Saves the labels to <root>/eval-data/linking/labels.json (0700 directory, 0600 file, replaced atomically) */
export function saveLabels(root: string, labels: LinkingLabels): string {
  const dir = prepareOutDir(root, LINKING_DIR);
  return writePrivateFile(dir, LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
}

/** Adds or replaces the verdict on a pair (stored with a < b) */
export function setPairLabel(labels: LinkingLabels, label: PairLabel): void {
  const [a, b] = label.a < label.b ? [label.a, label.b] : [label.b, label.a];
  const key = pairKey(a, b);
  labels.pairs = labels.pairs.filter((p) => pairKey(p.a, p.b) !== key);
  labels.pairs.push({ ...label, a, b });
}

/** Marks a message "not work", or clears the mark. Returns whether it's marked now. */
export function toggleNotWork(labels: LinkingLabels, message: string, labeledAt = new Date().toISOString()): boolean {
  const had = labels.notWork.some((n) => n.message === message);
  labels.notWork = labels.notWork.filter((n) => n.message !== message);
  if (!had) labels.notWork.push({ message, labeledAt });
  return !had;
}
