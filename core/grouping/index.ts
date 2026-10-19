// core/grouping/index.ts — The v2 grouping: clustering, then the over-merge detector's splits
//
// What the evaluation, the lab and the regroup dry run all run, so they always agree. The splits are on by default:
// on pairs drawn across every split it proposed in the reference history, all were judged different work.

import { cluster, type ClusterOptions, type Placement } from "./cluster.js";
import type { GroupingMessage } from "./recognize.js";
import { applySplits, proposeSplits } from "./split.js";

export interface GroupOptions extends ClusterOptions {
  /** Apply the over-merge detector's splits (default true) */
  split?: boolean;
}

export function groupMessages(messages: readonly GroupingMessage[], options: GroupOptions): Map<string, Placement> {
  const placed = cluster(messages, options);
  return options.split === false ? placed : applySplits(placed, proposeSplits(placed));
}
