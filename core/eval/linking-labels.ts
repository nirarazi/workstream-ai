// core/eval/linking-labels.ts — The operator's verdicts on message grouping (eval-data/linking/labels.json)
//
// Labels are keyed by a message's platform identity ("<platform>:<channel id>:<message id>", see messageKey in
// linking-data.ts), not by events.id: an event row's id is a random UUID that changes when messages are re-ingested
// or relinked, while the platform's id doesn't, so one set of verdicts scores the current grouping, the re-link
// proposal and any later one. The file names its key format, so a change to it is a new format version. Three kinds
// of label: a pair verdict (same work or different work), a "not work" mark on a single message, and a "mixed" mark on
// a message that moves several cases (a dispatch of three tickets), which one item can't hold. The file holds
// message keys and the operator's notes, so it lives in eval-data/ (gitignored), in a private directory, written as a
// private file. Each save re-reads the file and replays this session's labels onto it, so two labeling sessions
// don't overwrite each other's work.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { prepareOutDir, writePrivateFile } from "../graph/relink.js";

/**
 * The path of <root>/<dir>/<name> for reading, or null when it doesn't exist. Refused if the file is a symlink or the
 * directory resolves anywhere but where it should, so a read can't be redirected out of the project.
 */
export function projectFile(root: string, dir: string, name: string): string | null {
  const expected = join(realpathSync(root), dir);
  const path = join(expected, name);
  if (!existsSync(path)) return null;
  if (realpathSync(join(root, dir)) !== expected) throw new Error(`Refusing to read: ${join(root, dir)} resolves elsewhere`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to read: ${path} is a symlink`);
  return path;
}

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

/** A message that moves several cases: work, but no one item can hold all of it, so its pairs aren't scored */
export type MixedLabel = NotWorkLabel;

/** The two marks on a single message; a message has at most one of them */
export type MessageMark = "notWork" | "mixed";

export interface LinkingLabels {
  version: typeof LABELS_VERSION;
  /** Always KEY_FORMAT: says what the message keys below are */
  keyFormat: typeof KEY_FORMAT;
  pairs: PairLabel[];
  notWork: NotWorkLabel[];
  /** Absent in files written before it existed, read as none */
  mixed: MixedLabel[];
}

export function emptyLabels(): LinkingLabels {
  return { version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: [], notWork: [], mixed: [] };
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
  if (data.mixed !== undefined && !Array.isArray(data.mixed)) throw new Error("Linking labels: expected a mixed list");
  const mixed = data.mixed ?? [];
  const malformed = (n: NotWorkLabel) => !isString(n?.message) || !isString(n.labeledAt) || !optionalString(n.note);
  data.notWork.forEach((n, i) => {
    if (malformed(n)) throw new Error(`Linking labels: not-work label ${i + 1} is malformed`);
  });
  mixed.forEach((n, i) => {
    if (malformed(n)) throw new Error(`Linking labels: mixed label ${i + 1} is malformed`);
  });
  return { version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: data.pairs, notWork: data.notWork, mixed };
}

/** Other label sets beside the operator's (labels.<name>.json), such as a model's bulk labels; never a path */
export function labelsFileName(name?: string): string {
  if (name === undefined || name === LABELS_FILE) return LABELS_FILE;
  if (!/^labels\.[a-z0-9-]{1,32}\.json$/.test(name)) throw new Error(`Linking labels: ${name} isn't a labels file name (labels.<name>.json)`);
  return name;
}

/** The labels under <root>/eval-data/linking/, or none yet. A symlinked file, or a directory elsewhere, is refused. */
export function loadLabels(root: string, file = LABELS_FILE): LinkingLabels {
  const path = projectFile(root, LINKING_DIR, labelsFileName(file));
  return path ? parseLabels(readFileSync(path, "utf-8")) : emptyLabels();
}

/** Saves the labels to <root>/eval-data/linking/labels.json (or another labels file) (0700 directory, 0600 file, replaced atomically) */
export function saveLabels(root: string, labels: LinkingLabels, file = LABELS_FILE): string {
  const dir = prepareOutDir(root, LINKING_DIR);
  return writePrivateFile(dir, labelsFileName(file), JSON.stringify(labels, null, 2) + "\n");
}

/** Adds or replaces the verdict on a pair (stored with a < b) */
export function setPairLabel(labels: LinkingLabels, label: PairLabel): void {
  const [a, b] = label.a < label.b ? [label.a, label.b] : [label.b, label.a];
  const key = pairKey(a, b);
  labels.pairs = labels.pairs.filter((p) => pairKey(p.a, p.b) !== key);
  labels.pairs.push({ ...label, a, b });
}

/** Gives a message a mark (replacing either mark it had: "not work" and "mixed" exclude each other), or clears it */
export function setMark(labels: LinkingLabels, mark: MessageMark, message: string, marked: boolean, labeledAt = new Date().toISOString(), note?: string): void {
  const other: MessageMark = mark === "notWork" ? "mixed" : "notWork";
  labels[mark] = labels[mark].filter((n) => n.message !== message);
  if (!marked) return;
  labels[other] = labels[other].filter((n) => n.message !== message);
  labels[mark].push(note ? { message, labeledAt, note } : { message, labeledAt });
}

/** Marks a message "not work" (replacing an earlier mark), or clears its mark */
export function setNotWork(labels: LinkingLabels, message: string, marked: boolean, labeledAt = new Date().toISOString(), note?: string): void {
  setMark(labels, "notWork", message, marked, labeledAt, note);
}

/** Gives a message a mark, or clears it. Returns whether it has the mark now. */
export function toggleMark(labels: LinkingLabels, mark: MessageMark, message: string, labeledAt = new Date().toISOString(), note?: string): boolean {
  const marked = !labels[mark].some((n) => n.message === message);
  setMark(labels, mark, message, marked, labeledAt, note);
  return marked;
}

/** Marks a message "not work", or clears the mark. Returns whether it's marked now. */
export function toggleNotWork(labels: LinkingLabels, message: string, labeledAt = new Date().toISOString(), note?: string): boolean {
  return toggleMark(labels, "notWork", message, labeledAt, note);
}

type LabelOp =
  | { kind: "pair"; label: PairLabel }
  | { kind: MessageMark; message: string; marked: boolean; labeledAt: string; note?: string };

function applyOp(labels: LinkingLabels, op: LabelOp): void {
  if (op.kind === "pair") setPairLabel(labels, op.label);
  else setMark(labels, op.kind, op.message, op.marked, op.labeledAt, op.note);
}

/** Whether the labels already hold a newer label for the op's pair or message (another session's, saved since) */
function newerThan(labels: LinkingLabels, op: LabelOp): boolean {
  if (op.kind === "pair") {
    const key = pairKey(op.label.a, op.label.b);
    return labels.pairs.some((p) => pairKey(p.a, p.b) === key && p.labeledAt > op.label.labeledAt);
  }
  return [...labels.notWork, ...labels.mixed].some((n) => n.message === op.message && n.labeledAt > op.labeledAt);
}

/**
 * A labeling session's view of the labels. Each change is saved at once: the file is read again and the session's
 * unsaved changes applied onto it, so labels another session saved meanwhile are kept, and a change is never applied
 * over a newer label for the same pair or message. Once saved, a change is the file's and isn't replayed again. There's
 * no lock: two saves at the same instant can still race, which a single operator's tool accepts.
 */
export class LabelSession {
  labels: LinkingLabels;
  /** Changes not saved yet (kept only when a save failed, to be replayed by the next) */
  private pending: LabelOp[] = [];

  constructor(private readonly root: string) {
    this.labels = loadLabels(root);
  }

  setPair(label: PairLabel): void {
    this.record({ kind: "pair", label });
  }

  /** Toggles a mark on a message, as the file holds it now; returns whether it has the mark */
  toggleMark(mark: MessageMark, message: string, note?: string): boolean {
    this.labels = this.merged();
    const marked = !this.labels[mark].some((n) => n.message === message);
    this.record({ kind: mark, message, marked, labeledAt: new Date().toISOString(), note });
    return marked;
  }

  toggleNotWork(message: string, note?: string): boolean {
    return this.toggleMark("notWork", message, note);
  }

  /** Saves the unsaved changes over whatever the file holds now (nothing to write when there are none) */
  save(): void {
    if (this.pending.length === 0) return;
    const merged = this.merged();
    saveLabels(this.root, merged);
    this.pending = [];
    this.labels = merged;
  }

  /** The file as it is now, with the unsaved changes that aren't older than what it holds */
  private merged(): LinkingLabels {
    const fresh = loadLabels(this.root);
    for (const op of this.pending) if (!newerThan(fresh, op)) applyOp(fresh, op);
    return fresh;
  }

  private record(op: LabelOp): void {
    this.pending.push(op);
    applyOp(this.labels, op);
    this.save();
  }
}

