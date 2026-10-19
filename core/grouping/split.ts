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

function evidence(p: Placement): string {
  return (p.reasons[0] ?? "").split(/[ ,]/)[0];
}

/** The splits to propose: per case, the weak bridge with the most balanced cut, if any */
export function proposeSplits(placements: ReadonlyMap<string, Placement>, minPart = 2): Split[] {
  const byCluster = new Map<string, string[]>();
  for (const [key, p] of placements) if (p.cluster) byCluster.set(p.cluster, [...(byCluster.get(p.cluster) ?? []), key]);
  const out: Split[] = [];
  for (const [id, members] of byCluster) {
    if (members.length < minPart * 2) continue;
    const inCase = new Set(members);
    const children = new Map<string, string[]>();
    for (const k of members) {
      const via = placements.get(k)!.via;
      if (via && inCase.has(via) && via !== k) children.set(via, [...(children.get(via) ?? []), k]);
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
    const keysOf = (ks: readonly string[]) => new Set(ks.map((k) => placements.get(k)!.recognized.about).filter((a): a is string => a !== null));
    let best: Split | null = null;
    let bestBalance = 0;
    for (const k of members) {
      const p = placements.get(k)!;
      if (!p.via || !inCase.has(p.via) || !WEAK.has(evidence(p))) continue;
      const moved = subtree(k);
      const rest = members.filter((m) => !moved.includes(m));
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
      out.set(k, { ...p, cluster: `${s.cluster}/${s.at}`, ...(k === s.at ? { via: null, reasons: [...p.reasons, "split: weak bridge"] } : {}) });
    }
  }
  return out;
}
