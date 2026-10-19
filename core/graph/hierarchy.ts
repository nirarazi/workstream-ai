// core/graph/hierarchy.ts — Where a tracker's item types sit in the work model (docs/work-model.md, "Tracker hierarchy")
//
// Each item type has a role. A container (an epic) holds many cases and is never one; a case (a story, a task, a bug)
// is one; a step (a sub-task) is part of its parent's case. The default comes from the tracker's structure (its
// hierarchy level), not from type names, so a renamed or custom type lands right; the operator's overrides, by type id
// and optionally project, win over it.

import type { WorkItemDetail } from "../types.js";

export type ItemRole = "container" | "case" | "step";

export interface ItemTypeRoleOverride {
  /** The tracker's id for the type (stable across renames) */
  typeId: string;
  role: ItemRole;
  /** Only in this project (its key, e.g. "OPS"); every project when absent */
  project?: string;
}

/** The role of an item type: an override for its project, then one for any project, then its hierarchy level */
export function roleOf(
  itemType: NonNullable<WorkItemDetail["itemType"]>,
  project: string | null,
  overrides: readonly ItemTypeRoleOverride[] = [],
): ItemRole {
  const own = overrides.filter((o) => o.typeId === itemType.id);
  const override = own.find((o) => o.project !== undefined && project !== null && o.project.toUpperCase() === project.toUpperCase())
    ?? own.find((o) => o.project === undefined);
  if (override) return override.role;
  const level = itemType.hierarchyLevel;
  if (level === null || level === undefined) return "case";
  return level > 0 ? "container" : level < 0 ? "step" : "case";
}

/** The project of a ticket key ("OPS" for OPS-101), or null */
export function projectOf(key: string): string | null {
  const dash = key.lastIndexOf("-");
  return dash > 0 ? key.slice(0, dash).toUpperCase() : null;
}

/**
 * The item a tracker item belongs to, by its structure: a step's parent, or the item it duplicates. Null when it's
 * a case of its own (or a container, which the tracker's links never fold into anything).
 */
export function belongsTo(
  detail: WorkItemDetail,
  overrides: readonly ItemTypeRoleOverride[] = [],
): { key: string; reason: "step" | "duplicate" } | null {
  const role = detail.itemType ? roleOf(detail.itemType, projectOf(detail.id), overrides) : "case";
  // A container holds cases: it's never folded into anything, by a duplicate link or a parent
  if (role === "container") return null;
  const duplicateOf = detail.duplicates?.[0];
  if (duplicateOf) return { key: duplicateOf, reason: "duplicate" };
  return role === "step" && detail.parent ? { key: detail.parent.key, reason: "step" } : null;
}
