// core/graph/item-keys.ts — Keys that name a work item (docs/work-model.md, section 5, "Storage")
//
// A work item's id is opaque: what names the work is its keys. A key is "<kind>:<value>": ticket:OPS-101,
// pr:forge.example/org/repo#7, mcp:<the id an agent passed>, and the legacy thread:<thread id>, which new items never
// get. An item can hold several keys; a key is held by one live item. Keys are retired, never deleted, so where a key
// pointed before stays on record. Items made before keys existed keep their ids, and get the key their id already was.

import { looksLikeTicketKey } from "./extractors/default.js";

export type ItemKeyKind = "ticket" | "pr" | "mcp" | "thread";

export interface ItemKey {
  key: string;
  itemId: string;
  /** Where the key came from: the item's source (jira, extracted, inferred, mcp) or "operator" */
  source: string;
  confidence: number;
  /** Who decided it: backfill, engine, merge, unmerge or operator */
  decidedBy: string;
  /** Why, where that isn't obvious: for a merge, the item the key came from */
  evidence: string | null;
  createdAt: string;
  retiredAt: string | null;
}

/** The source of items an agent reports through MCP (core/mcp/server.ts) */
const MCP_SOURCE = "mcp";

export function ticketKey(id: string): string {
  return `ticket:${id.toUpperCase()}`;
}

export function keyKind(key: string): ItemKeyKind | null {
  const kind = key.slice(0, key.indexOf(":"));
  return kind === "ticket" || kind === "pr" || kind === "mcp" || kind === "thread" ? kind : null;
}

/**
 * The key an item's id already was, for items made before ids were opaque, or null when the id names nothing a key
 * can (a title the classifier once returned as an id, say). An id an agent passed through MCP is a ticket key when
 * it's shaped like one, else an mcp: key.
 */
export function legacyKeyOf(id: string, source: string): string | null {
  if (id.startsWith("thread:")) return id.length > "thread:".length ? id : null;
  if (looksLikeTicketKey(id)) return ticketKey(id);
  if (source === MCP_SOURCE) return `mcp:${id}`;
  return null;
}
