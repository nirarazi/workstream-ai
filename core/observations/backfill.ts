// core/observations/backfill.ts — Observations for the messages classified before observations were recorded
//
// The database never stored the workspace a message came from, so the connected adapter keys them: each event of its
// platform with no observation is rebuilt as the message it was and observed. A message filed under several threads
// is observed from its row in the thread it replies in (not one filed under its own id), so what it replies to is
// right. Idempotent: linked events are skipped, so it runs on every start and picks up where it stopped.

import type { MessagingAdapter } from "../adapters/messaging/interface.js";
import type { ContextGraph } from "../graph/index.js";
import type { Database } from "../graph/db.js";
import type { Message } from "../types.js";
import type { ObservationDraft } from "./types.js";

const BATCH = 500;

interface StoredMessage {
  message_id: string;
  thread_id: string;
  channel_id: string;
  channel_name: string;
  raw_text: string;
  timestamp: string;
  user_id: string | null;
  user_name: string | null;
  is_bot: number | null;
  bot_type: string | null;
}

function senderType(row: StoredMessage): Message["senderType"] {
  if (row.bot_type === "notification") return "notification";
  if (row.is_bot === 1) return "agent";
  if (row.is_bot === 0) return "human";
  return "unknown";
}

/** Returns how many observations it recorded */
export function backfillObservations(db: Database, graph: ContextGraph, adapter: MessagingAdapter): number {
  if (!adapter.observe) return 0;
  const rows = db.db.prepare(`
    SELECT e.message_id, e.thread_id, t.channel_id, t.channel_name, e.raw_text, e.timestamp,
           a.platform_user_id AS user_id, a.name AS user_name, a.is_bot, a.bot_type
    FROM events e
    JOIN threads t ON t.id = e.thread_id
    LEFT JOIN agents a ON a.id = e.agent_id
    WHERE e.observation_id IS NULL AND t.platform = ?
    ORDER BY e.timestamp, (e.thread_id = e.message_id)
  `).all(adapter.name) as StoredMessage[];

  const seen = new Set<string>();
  const drafts: ObservationDraft[] = [];
  for (const row of rows) {
    const key = `${row.channel_id}/${row.message_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const draft = adapter.observe({
      id: row.message_id,
      threadId: row.thread_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      userId: row.user_id ?? "",
      userName: row.user_name ?? "",
      text: row.raw_text,
      timestamp: row.timestamp,
      platform: adapter.name,
      senderType: senderType(row),
    });
    if (draft) drafts.push(draft);
  }
  for (let i = 0; i < drafts.length; i += BATCH) graph.recordObservations(drafts.slice(i, i + BATCH));
  return drafts.length;
}
