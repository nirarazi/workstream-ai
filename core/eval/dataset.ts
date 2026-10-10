// core/eval/dataset.ts — Labeled evaluation set for the classifier (JSONL, one item per line)
//
// The dataset holds real fleet messages, so it lives in eval-data/ which is gitignored.
// Never commit it: the repo is meant to go open source.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StatusCategory } from "../types.js";

export const STATUSES: StatusCategory[] = ["completed", "in_progress", "blocked_on_human", "needs_decision", "noise"];

export interface EvalItem {
  /** events.id of the source message. */
  id: string;
  message: string;
  senderName: string;
  senderType: string;
  channelName: string;
  timestamp: string;
  /** What the live classifier stored at the time. Used to pre-fill labeling, never as ground truth. */
  production: {
    status: StatusCategory;
    confidence: number;
    targetedAtOperator: boolean;
  };
  /** Human ground truth. Absent until labeled. */
  label?: {
    status: StatusCategory;
    targetedAtOperator: boolean;
    labeledAt: string;
    note?: string;
  };
}

export function defaultDatasetPath(projectRoot: string): string {
  return resolve(projectRoot, "eval-data", "classifier.jsonl");
}

export function loadDataset(path: string): EvalItem[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalItem);
}

export function saveDataset(path: string, items: EvalItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

export function labeled(items: EvalItem[]): Array<EvalItem & { label: NonNullable<EvalItem["label"]> }> {
  return items.filter((i): i is EvalItem & { label: NonNullable<EvalItem["label"]> } => !!i.label);
}
