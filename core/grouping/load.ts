// core/grouping/load.ts — The messages the grouping reads, from the database (read only)
//
// One per message, keyed "<platform>:<channel id>:<message id>" as the evaluation's labels are, so the lab and the
// evaluation agree on what a message is. A message stored under several threads is read from its row in the thread it
// replies in (a row filed under its own id is the channel-history copy). Only the sender's own lines are kept.

import type BetterSqlite3 from "better-sqlite3";
import { ownLines } from "../graph/own-lines.js";
import type { SenderKind } from "../graph/resolver.js";
import type { StatusCategory } from "../types.js";
import type { GroupingMessage } from "./recognize.js";

export interface LoadedMessage extends GroupingMessage {
  senderName: string;
  channelName: string;
  /** events.id of the row read */
  eventId: string;
  /** The classifier put it in front of the operator (events.targeted_at_operator) */
  targetedAtOperator: boolean;
}

function hasColumn(db: BetterSqlite3.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === column);
}

function senderKind(isBot: number | null, botType: string | null): SenderKind {
  if (botType === "notification") return "notification";
  if (isBot === 1) return "agent";
  if (isBot === 0) return "human";
  return "unknown";
}

export function loadGroupingMessages(db: BetterSqlite3.Database): LoadedMessage[] {
  const digest = hasColumn(db, "events", "digest") ? "e.digest" : "0";
  const bot = hasColumn(db, "agents", "bot_type") ? "a.is_bot, a.bot_type" : "NULL AS is_bot, NULL AS bot_type";
  const targeted = hasColumn(db, "events", "targeted_at_operator") ? "e.targeted_at_operator" : "0";
  const rows = db.prepare(`
    SELECT e.id, e.thread_id, e.message_id, e.agent_id, e.status, e.raw_text, e.timestamp, ${digest} AS digest, ${targeted} AS targeted,
           t.platform, t.channel_id, COALESCE(t.channel_name, '') AS channel_name, COALESCE(a.name, 'unknown') AS sender_name, ${bot}
    FROM events e LEFT JOIN threads t ON t.id = e.thread_id LEFT JOIN agents a ON a.id = e.agent_id
    WHERE e.message_id NOT LIKE 'operator-%'
    ORDER BY e.rowid
  `).all() as Array<{
    id: string; thread_id: string; message_id: string; agent_id: string | null; status: StatusCategory; raw_text: string | null;
    timestamp: string; digest: number; targeted: number; platform: string | null; channel_id: string | null; channel_name: string; sender_name: string;
    is_bot: number | null; bot_type: string | null;
  }>;
  const chosen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.platform ?? "unknown"}:${r.channel_id ?? ""}:${r.message_id}`;
    const held = chosen.get(key);
    // The row in the thread it replies in wins over one filed under its own id
    if (!held || (held.thread_id === held.message_id && r.thread_id !== r.message_id)) chosen.set(key, r);
  }
  const out: LoadedMessage[] = [];
  for (const [key, r] of chosen) {
    const text = ownLines(r.raw_text ?? "").trim();
    if (!text) continue;
    out.push({
      key,
      eventId: r.id,
      threadId: r.thread_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      senderId: r.agent_id,
      senderName: r.sender_name,
      senderKind: senderKind(r.is_bot, r.bot_type),
      at: r.timestamp,
      text,
      status: r.status,
      digest: r.digest === 1,
      topLevel: r.thread_id === r.message_id,
      targetedAtOperator: r.targeted === 1,
    });
  }
  return out;
}
