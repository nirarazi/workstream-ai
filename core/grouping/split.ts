// core/grouping/split.ts — Over-merges, found as weak bridges in a case's graph (docs/work-model.md §3, "The graph")
//
// Each message in a case hangs from the one whose evidence drew it in (Placement.via), so a case is a tree. An edge
// drawn by weak evidence (a top-level exchange, a sender going on, a near-copy) that joins two parts, each of several
// messages and each about keys the other never names, is likely two cases joined by one weak link: cutting it is the
// split to propose. Strong evidence (a thread, a key, the operator) is never cut. Pure.

import type { Placement } from "./cluster.js";

const WEAK = new Set(["exchange", "continuation", "nearCopy", "followUp"]);

export interface Split {
  cluster: string;
  /** The weak edge cut: the message drawn in, and the message that drew it */
  at: string;
  via: string;
  /** The messages that leave with the cut */
  moved: string[];
}


/**
 * The splits to propose: per case, the weak bridge with the most balanced cut, if any. Thread edges are never cut:
 * pairs drawn across cuts of long threads walking several subjects were judged the same work as often as not.
 */
export function proposeSplits(placements: ReadonlyMap<string, Placement>, minPart = 2): Split[] {
  const byCluster = new Map<string, string[]>();
  for (const [key, p] of placements) {
    if (!p.cluster) continue;
    const members = byCluster.get(p.cluster);
    if (members) members.push(key);
    else byCluster.set(p.cluster, [key]);
  }
  const out: Split[] = [];
  for (const [id, members] of byCluster) {
    if (members.length < minPart * 2) continue;
    const keysOf = (ks: Iterable<string>) => {
      const out = new Set<string>();
      for (const k of ks) {
        const about = placements.get(k)!.recognized.about;
        if (about !== null) out.add(about);
      }
      return out;
    };
    // A cut leaves keys on both sides that the other never names: a case naming fewer than two has none to propose
    if (keysOf(members).size < 2) continue;
    const inCase = new Set(members);
    const children = new Map<string, string[]>();
    for (const k of members) {
      const via = placements.get(k)!.via;
      if (!via || !inCase.has(via) || via === k) continue;
      const siblings = children.get(via);
      if (siblings) siblings.push(k);
      else children.set(via, [k]);
    }
    const subtree = (root: string): string[] => {
      const seen: string[] = [];
      const stack = [root];
      while (stack.length) {
        const k = stack.pop()!;
        seen.push(k);
        for (const c of children.get(k) ?? []) stack.push(c);
      }
      return seen;
    };
    let best: Split | null = null;
    let bestBalance = 0;
    for (const k of members) {
      const p = placements.get(k)!;
      // The evidence that drew it in, not its first reason: a must-link listed after a follow-up is never cut
      if (!p.via || !inCase.has(p.via) || !WEAK.has(p.viaReason ?? "")) continue;
      const moved = subtree(k);
      const movedSet = new Set(moved);
      const rest = members.filter((m) => !movedSet.has(m));
      if (moved.length < minPart || rest.length < minPart) continue;
      const a = keysOf(moved);
      const b = keysOf(rest);
      if (a.size === 0 || b.size === 0 || [...a].some((x) => b.has(x))) continue;
      const balance = Math.min(moved.length, rest.length);
      if (balance > bestBalance) {
        bestBalance = balance;
        best = { cluster: id, at: k, via: p.via, moved };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** The placements with the proposed splits applied: what moves gets a cluster of its own */
export function applySplits(placements: ReadonlyMap<string, Placement>, splits: readonly Split[]): Map<string, Placement> {
  const out = new Map(placements);
  for (const s of splits) {
    for (const k of s.moved) {
      const p = out.get(k)!;
      out.set(k, { ...p, cluster: `${s.cluster}/${s.at}`, ...(k === s.at ? { via: null, viaReason: null, reasons: [...p.reasons, "split: weak bridge"] } : {}) });
    }
  }
  return out;
}
