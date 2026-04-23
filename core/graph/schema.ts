// core/graph/schema.ts — Raw row types mirroring the SQLite tables

import type { StatusCategory } from "../types.js";

export interface AgentRow {
  id: string;
  name: string;
  platform: string;
  platform_user_id: string;
  role: string | null;
  avatar_url: string | null;
  is_bot: number | null;
  bot_type: string | null;
  first_seen: string;
  last_seen: string;
}

export interface WorkItemRow {
  id: string;
  source: string;
  title: string;
  external_status: string | null;
  assignee: string | null;
  url: string | null;
  current_atc_status: StatusCategory | null;
  current_confidence: number | null;
  snoozed_until: string | null;
  pinned: number;         // 0 or 1
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: string;
  channel_id: string;
  channel_name: string;
  platform_meta: string;
  platform: string;
  work_item_id: string | null;
  last_activity: string;
  message_count: number;
  manually_linked: number;
}

export interface EventRow {
  id: string;
  thread_id: string;
  message_id: string;
  work_item_id: string | null;
  agent_id: string | null;
  status: StatusCategory;
  confidence: number;
  reason: string;
  raw_text: string;
  timestamp: string;
  created_at: string;
  entry_type: string;
  targeted_at_operator: number;
  action_required_from: string | null;
  next_action: string | null;
}

export interface EnrichmentRow {
  id: string;
  work_item_id: string;
  source: string;
  data: string;
  fetched_at: string;
}

export interface PollCursorRow {
  channel_id: string;
  last_timestamp: string;
  updated_at: string;
}

export interface SummaryRow {
  work_item_id: string;
  summary_text: string;
  generated_at: string;
  latest_event_id: string;
}
