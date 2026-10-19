// core/eval/v2-grouping.ts — The v2 grouping (core/grouping/), computed from a database copy for npm run eval:linking
//
// Each message (its representative row, as the labels see it) is given to the clusterer with its sender's kind, its
// classification and its digest flag. The operator's constraints aren't applied here: they become labels of their own
// (npm run eval:constraint-labels), and applying them would score the grouping against itself.

import type BetterSqlite3 from "better-sqlite3";
import { DefaultExtractor } from "../graph/extractors/default.js";
import { hasColumn } from "../graph/relink.js";
import type { SenderKind } from "../graph/resolver.js";
import type { ClusterOptions, Placement } from "../grouping/cluster.js";
import { groupMessages } from "../grouping/index.js";
import type { GroupingMessage } from "../grouping/recognize.js";
import type { StatusCategory } from "../types.js";
import type { MessageIndex } from "./linking-data.js";
import type { Grouping } from "./linking-metrics.js";

const DEFAULT_TICKET_PATTERN = "\\b([A-Z]{2,6}-\\d+)\\b";

function senderKind(isBot: number | null, botType: string | null): SenderKind {
  if (botType === "notification") return "notification";
  if (isBot === 1) return "agent";
  if (isBot === 0) return "human";
  return "unknown";
}

/** The messages as the clusterer takes them, keyed by message key */
export function groupingMessages(db: BetterSqlite3.Database, index: Pick<MessageIndex, "observations">): GroupingMessage[] {
  const digest = hasColumn(db, "events", "digest") ? "e.digest" : "0";
  const bot = hasColumn(db, "agents", "bot_type") ? "a.is_bot, a.bot_type" : "NULL AS is_bot, NULL AS bot_type";
  const rows = new Map((db.prepare(`
    SELECT e.id, e.status, ${digest} AS digest, ${bot} FROM events e LEFT JOIN agents a ON a.id = e.agent_id
  `).all() as Array<{ id: string; status: StatusCategory; digest: number; is_bot: number | null; bot_type: string | null }>)
    .map((r) => [r.id, r]));
  return index.observations.map((o) => {
    const r = rows.get(o.eventId);
    return {
      key: o.id,
      threadId: o.threadId,
      channelId: o.channelId,
      senderId: o.senderId,
      senderKind: r ? senderKind(r.is_bot, r.bot_type) : "unknown",
      at: o.timestamp,
      text: o.text,
      status: r?.status ?? null,
      digest: r?.digest === 1,
      // A thread is keyed by its first message's id: a message that is its thread's first is top-level
      topLevel: o.id.endsWith(`:${o.threadId}`),
    };
  });
}

export function v2Options(overrides: Partial<ClusterOptions> = {}): ClusterOptions {
  const extractor = new DefaultExtractor({ ticketPatterns: [DEFAULT_TICKET_PATTERN] });
  return { extractTickets: (text) => extractor.extractWorkItemIds(text), ...overrides };
}

/** Message key → cluster, for the messages placed; and every placement, for explaining them */
export function v2Grouping(db: BetterSqlite3.Database, index: Pick<MessageIndex, "observations">, overrides: Partial<ClusterOptions> = {}): {
  grouping: Grouping;
  placements: Map<string, Placement>;
} {
  // WORKSTREAM_V2_SPLIT=false leaves out the over-merge detector's splits, to score without them
  const placements = groupMessages(groupingMessages(db, index), { ...v2Options(overrides), split: process.env.WORKSTREAM_V2_SPLIT !== "false" });
  const grouping = new Map<string, string>();
  for (const [key, p] of placements) if (p.cluster) grouping.set(key, p.cluster);
  return { grouping, placements };
}
