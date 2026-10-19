// core/graph/constraints.ts — The operator's corrections, kept so every regrouping respects them (docs/work-model.md, §5)
//
// A constraint names observations (by dedupeKey) or keys, never item ids, so it survives any recompute of the items.
// Kinds: must_link and cannot_link (two observations), pin (an observation to a key), not_an_item (one observation),
// key_alias (two keys name the same work), and for streams in_stream and not_in_stream (later steps). Each records the
// action it came from (`origin`, e.g. "merge:<item id>"), so undoing that action retires it, and the backfill never
// writes one for an action that already has one, live or retired. Undoing sets retired_at; nothing is deleted.
//
// Constraints can contradict: a cannot_link between two observations that a chain of must_links (and pins and aliases,
// through the keys they name) joins. The newest wins; the older is suspended (still live and shown, not applied) until
// the operator retires one of them.

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "../observations/ulid.js";

export type ConstraintKind = "must_link" | "cannot_link" | "pin" | "not_an_item" | "key_alias" | "in_stream" | "not_in_stream";

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  a: string;
  b: string | null;
  /** operator, backfill, or what else decided it */
  decidedBy: string;
  /** The action it came from: "merge:<source item>", "link:<thread>", "unlink:<thread>", "noise:<item>", … */
  origin: string | null;
  createdAt: string;
  retiredAt: string | null;
  suspendedAt: string | null;
  supersededBy: string | null;
}

interface ConstraintRow {
  id: string;
  kind: string;
  a: string;
  b: string | null;
  decided_by: string;
  origin: string | null;
  created_at: string;
  retired_at: string | null;
  suspended_at: string | null;
  superseded_by: string | null;
}

export const CONSTRAINTS_SQL = `
CREATE TABLE IF NOT EXISTS constraints (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  a             TEXT NOT NULL,
  b             TEXT,
  decided_by    TEXT NOT NULL,
  origin        TEXT,
  created_at    TEXT NOT NULL,
  retired_at    TEXT,
  suspended_at  TEXT,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_constraints_origin ON constraints(origin);
CREATE INDEX IF NOT EXISTS idx_constraints_live ON constraints(kind) WHERE retired_at IS NULL;
`;

function toConstraint(r: ConstraintRow): Constraint {
  return {
    id: r.id,
    kind: r.kind as ConstraintKind,
    a: r.a,
    b: r.b,
    decidedBy: r.decided_by,
    origin: r.origin,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
    suspendedAt: r.suspended_at,
    supersededBy: r.superseded_by,
  };
}

/** Symmetric kinds are stored with a < b, so the same constraint is never written twice the other way round */
function ordered(kind: ConstraintKind, a: string, b: string | null): [string, string | null] {
  if (b !== null && (kind === "must_link" || kind === "cannot_link" || kind === "key_alias") && b < a) return [b, a];
  return [a, b];
}

export class ConstraintStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * Adds a constraint, unless the same action wrote the same one and it's live (then returns that one's id). Two
   * actions that mean the same thing each keep their own, so undoing one leaves the other. `createdAt` defaults to
   * now; the backfill passes the original action's time, so precedence follows when the operator acted.
   */
  add(c: { kind: ConstraintKind; a: string; b?: string | null; decidedBy: string; origin?: string | null; createdAt?: string }): string {
    const [a, b] = ordered(c.kind, c.a, c.b ?? null);
    const existing = this.db.prepare(
      "SELECT id FROM constraints WHERE kind = ? AND a = ? AND b IS ? AND origin IS ? AND retired_at IS NULL",
    ).get(c.kind, a, b, c.origin ?? null) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = ulid();
    this.db.prepare(`
      INSERT INTO constraints (id, kind, a, b, decided_by, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, c.kind, a, b, c.decidedBy, c.origin ?? null, c.createdAt ?? new Date().toISOString());
    return id;
  }

  /** Retires the live constraints an action wrote; returns how many */
  retireByOrigin(origin: string, at = new Date().toISOString()): number {
    return this.db.prepare("UPDATE constraints SET retired_at = ? WHERE origin = ? AND retired_at IS NULL").run(at, origin).changes;
  }

  retire(id: string, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE constraints SET retired_at = ? WHERE id = ? AND retired_at IS NULL").run(at, id);
  }

  /** Whether an action has ever written a constraint (live or retired): the backfill's guard */
  hasOrigin(origin: string): boolean {
    return this.db.prepare("SELECT 1 FROM constraints WHERE origin = ? LIMIT 1").get(origin) !== undefined;
  }

  /** Live constraints (suspended ones included, marked), oldest first */
  live(kind?: ConstraintKind): Constraint[] {
    const rows = this.db.prepare(`
      SELECT * FROM constraints WHERE retired_at IS NULL ${kind ? "AND kind = ?" : ""} ORDER BY created_at, id
    `).all(...(kind ? [kind] : [])) as ConstraintRow[];
    return rows.map(toConstraint);
  }

  /**
   * Finds contradictions among the live constraints and suspends the older side of each: the cannot_link, or the
   * newest link that joins its two ends, whichever is older. Suspensions it no longer finds are lifted. Returns the
   * ids suspended now.
   */
  settle(at = new Date().toISOString()): string[] {
    const all = this.live();
    const suspend = contradictions(all);
    const keep = new Set(suspend.map((s) => s.suspend));
    const tx = this.db.transaction(() => {
      for (const c of all) {
        if (keep.has(c.id) && !c.suspendedAt) {
          const by = suspend.find((s) => s.suspend === c.id)!.by;
          this.db.prepare("UPDATE constraints SET suspended_at = ?, superseded_by = ? WHERE id = ?").run(at, by, c.id);
        } else if (!keep.has(c.id) && c.suspendedAt) {
          this.db.prepare("UPDATE constraints SET suspended_at = NULL, superseded_by = NULL WHERE id = ?").run(c.id);
        }
      }
    });
    tx();
    return [...keep];
  }
}

/** Union-find over strings */
class Components {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    let node = x;
    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** The links that join nodes: must_link and key_alias directly, a pin through the key it names */
const JOINS: ReadonlySet<ConstraintKind> = new Set(["must_link", "key_alias", "pin"]);

/**
 * Pure. For each live cannot_link whose ends the links join, which constraint to suspend: the older of the
 * cannot_link and the newest link it takes to join them (newest wins). Links are added oldest first, so the link that
 * first joins the two ends is the newest one needed.
 */
export function contradictions(live: readonly Constraint[]): Array<{ suspend: string; by: string }> {
  const links = live.filter((c) => JOINS.has(c.kind) && c.b !== null);
  const cannot = live.filter((c) => c.kind === "cannot_link" && c.b !== null);
  const out: Array<{ suspend: string; by: string }> = [];
  for (const no of cannot) {
    const parts = new Components();
    let joinedBy: Constraint | null = null;
    for (const link of links) {
      parts.union(link.a, link.b!);
      if (parts.find(no.a) === parts.find(no.b!)) {
        joinedBy = link;
        break;
      }
    }
    if (!joinedBy) continue;
    const newer = joinedBy.createdAt > no.createdAt || (joinedBy.createdAt === no.createdAt && joinedBy.id > no.id);
    out.push(newer ? { suspend: no.id, by: joinedBy.id } : { suspend: joinedBy.id, by: no.id });
  }
  return out;
}
