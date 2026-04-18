// core/graph/index.ts — ContextGraph: main API for all database operations

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type {
  ActionableItem,
  Agent,
  Enrichment,
  EntryType,
  Event,
  PollCursor,
  StatusCategory,
  Thread,
  WorkItem,
} from "../types.js";
import type { Database } from "./db.js";
import type {
  AgentRow,
  EnrichmentRow,
  EventRow,
  PollCursorRow,
  SummaryRow,
  ThreadRow,
  WorkItemRow,
} from "./schema.js";

const log = createLogger("graph");

// --- Row-to-type mappers ---

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    externalStatus: row.external_status,
    assignee: row.assignee,
    url: row.url,
    currentAtcStatus: row.current_atc_status as StatusCategory | null,
    currentConfidence: row.current_confidence,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    platformMeta: row.platform_meta ? JSON.parse(row.platform_meta) : undefined,
    platform: row.platform,
    workItemId: row.work_item_id,
    lastActivity: row.last_activity,
    messageCount: row.message_count,
    messages: [],
    manuallyLinked: row.manually_linked === 1,
  };
}

function toEvent(row: EventRow): Event {
  let actionRequiredFrom: string[] | null = null;
  if (row.action_required_from) {
    try {
      actionRequiredFrom = JSON.parse(row.action_required_from);
    } catch {
      actionRequiredFrom = null;
    }
  }

  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    status: row.status as StatusCategory,
    confidence: row.confidence,
    reason: row.reason,
    rawText: row.raw_text,
    timestamp: row.timestamp,
    createdAt: row.created_at,
    entryType: (row.entry_type as EntryType) ?? "progress",
    targetedAtOperator: Boolean(row.targeted_at_operator ?? 1),
    actionRequiredFrom,
    nextAction: row.next_action ?? null,
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    role: row.role,
    avatarUrl: row.avatar_url,
    isBot: row.is_bot != null ? row.is_bot === 1 : null,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

function toEnrichment(row: EnrichmentRow): Enrichment {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    source: row.source,
    data: JSON.parse(row.data) as Record<string, unknown>,
    fetchedAt: row.fetched_at,
  };
}

function toPollCursor(row: PollCursorRow): PollCursor {
  return {
    channelId: row.channel_id,
    lastTimestamp: row.last_timestamp,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: SummaryRow): { workItemId: string; summaryText: string; generatedAt: string; latestEventId: string } {
  return {
    workItemId: row.work_item_id,
    summaryText: row.summary_text,
    generatedAt: row.generated_at,
    latestEventId: row.latest_event_id,
  };
}

export class ContextGraph {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- Agents ---

  upsertAgent(agent: {
    id?: string;
    name: string;
    platform: string;
    platformUserId: string;
    role?: string | null;
    avatarUrl?: string | null;
    isBot?: boolean | null;
  }): Agent {
    const now = new Date().toISOString();
    const id = agent.id ?? randomUUID();

    const stmt = this.db.db.prepare(`
      INSERT INTO agents (id, name, platform, platform_user_id, role, avatar_url, is_bot, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        platform_user_id = excluded.platform_user_id,
        role = COALESCE(excluded.role, agents.role),
        avatar_url = COALESCE(excluded.avatar_url, agents.avatar_url),
        is_bot = COALESCE(excluded.is_bot, agents.is_bot),
        last_seen = excluded.last_seen
    `);
    const isBotValue = agent.isBot != null ? (agent.isBot ? 1 : 0) : null;
    stmt.run(id, agent.name, agent.platform, agent.platformUserId, agent.role ?? null, agent.avatarUrl ?? null, isBotValue, now, now);
    log.debug("Upserted agent", id);

    return this.getAgentById(id)!;
  }

  getAgentById(id: string): Agent | null {
    const row = this.db.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
    return row ? toAgent(row) : null;
  }

  getAllAgents(): Agent[] {
    const rows = this.db.db
      .prepare("SELECT * FROM agents ORDER BY last_seen DESC")
      .all() as AgentRow[];
    return rows.map(toAgent);
  }

  // --- Work Items ---

  upsertWorkItem(item: {
    id: string;
    source: string;
    title?: string;
    externalStatus?: string | null;
    assignee?: string | null;
    url?: string | null;
    currentAtcStatus?: StatusCategory | null;
    currentConfidence?: number | null;
    snoozedUntil?: string | null;
  }): WorkItem {
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT INTO work_items (id, source, title, external_status, assignee, url, current_atc_status, current_confidence, snoozed_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = COALESCE(excluded.source, work_items.source),
        title = CASE WHEN excluded.title = '' THEN work_items.title ELSE excluded.title END,
        external_status = COALESCE(excluded.external_status, work_items.external_status),
        assignee = COALESCE(excluded.assignee, work_items.assignee),
        url = COALESCE(excluded.url, work_items.url),
        current_atc_status = COALESCE(excluded.current_atc_status, work_items.current_atc_status),
        current_confidence = COALESCE(excluded.current_confidence, work_items.current_confidence),
        snoozed_until = excluded.snoozed_until,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      item.id,
      item.source,
      item.title ?? "",
      item.externalStatus ?? null,
      item.assignee ?? null,
      item.url ?? null,
      item.currentAtcStatus ?? null,
      item.currentConfidence ?? null,
      item.snoozedUntil ?? null,
      now,
      now,
    );
    log.debug("Upserted work item", item.id);

    return this.getWorkItemById(item.id)!;
  }

  getWorkItemById(id: string): WorkItem | null {
    const row = this.db.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
      | WorkItemRow
      | undefined;
    return row ? toWorkItem(row) : null;
  }

  // --- Threads ---

  upsertThread(thread: {
    id: string;
    channelId: string;
    channelName?: string;
    platformMeta?: Record<string, unknown>;
    platform: string;
    workItemId?: string | null;
    lastActivity?: string;
    messageCount?: number;
  }): Thread {
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT INTO threads (id, channel_id, channel_name, platform_meta, platform, work_item_id, last_activity, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        channel_name = CASE WHEN excluded.channel_name = '' THEN threads.channel_name ELSE excluded.channel_name END,
        platform_meta = excluded.platform_meta,
        platform = excluded.platform,
        work_item_id = COALESCE(excluded.work_item_id, threads.work_item_id),
        last_activity = excluded.last_activity,
        message_count = CASE WHEN excluded.message_count > threads.message_count THEN excluded.message_count ELSE threads.message_count END
    `);
    stmt.run(
      thread.id,
      thread.channelId,
      thread.channelName ?? "",
      JSON.stringify(thread.platformMeta ?? {}),
      thread.platform,
      thread.workItemId ?? null,
      thread.lastActivity ?? now,
      thread.messageCount ?? 0,
    );
    log.debug("Upserted thread", thread.id);

    return this.getThreadById(thread.id)!;
  }

  getThreadById(id: string): Thread | null {
    const row = this.db.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : null;
  }

  getThreadsForWorkItem(workItemId: string): Thread[] {
    const rows = this.db.db
      .prepare("SELECT * FROM threads WHERE work_item_id = ? ORDER BY last_activity DESC")
      .all(workItemId) as ThreadRow[];
    return rows.map(toThread);
  }

  linkThread(threadId: string, workItemId: string): void {
    this.db.db.prepare(
      "UPDATE threads SET work_item_id = ?, manually_linked = 1 WHERE id = ?"
    ).run(workItemId, threadId);
    log.debug("Manually linked thread", threadId, "to", workItemId);
  }

  unlinkThread(threadId: string): void {
    this.db.db.prepare(
      "UPDATE threads SET work_item_id = NULL, manually_linked = 0 WHERE id = ?"
    ).run(threadId);
    log.debug("Unlinked thread", threadId);
  }

  getUnlinkedThreads(limit: number, query?: string): Thread[] {
    let sql = `
      SELECT * FROM threads
      WHERE manually_linked = 0
        AND (work_item_id IS NULL OR work_item_id LIKE 'thread:%')
    `;
    const params: unknown[] = [];

    if (query) {
      sql += " AND channel_name LIKE ?";
      params.push(`%${query}%`);
    }

    sql += " ORDER BY last_activity DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.db.prepare(sql).all(...params) as ThreadRow[];
    return rows.map(toThread);
  }

  // --- Events ---

  insertEvent(event: {
    threadId: string;
    messageId: string;
    workItemId?: string | null;
    agentId?: string | null;
    status: StatusCategory;
    entryType?: EntryType;
    confidence: number;
    reason?: string;
    rawText?: string;
    timestamp: string;
    targetedAtOperator?: boolean;
    actionRequiredFrom?: string[] | null;
    nextAction?: string | null;
  }): Event {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT OR IGNORE INTO events (id, thread_id, message_id, work_item_id, agent_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type, targeted_at_operator, action_required_from, next_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      id,
      event.threadId,
      event.messageId,
      event.workItemId ?? null,
      event.agentId ?? null,
      event.status,
      event.confidence,
      event.reason ?? "",
      event.rawText ?? "",
      event.timestamp,
      now,
      event.entryType ?? "progress",
      (event.targetedAtOperator ?? true) ? 1 : 0,
      event.actionRequiredFrom ? JSON.stringify(event.actionRequiredFrom) : null,
      event.nextAction ?? null,
    );

    if (result.changes === 0) {
      // Duplicate — return existing event
      const existing = this.db.db.prepare(
        "SELECT * FROM events WHERE message_id = ? AND thread_id = ?"
      ).get(event.messageId, event.threadId) as EventRow;
      return toEvent(existing);
    }

    log.debug("Inserted event", id);
    return this.getEventById(id)!;
  }

  hasEvent(messageId: string, threadId: string): boolean {
    const row = this.db.db.prepare(
      "SELECT 1 FROM events WHERE message_id = ? AND thread_id = ? LIMIT 1"
    ).get(messageId, threadId);
    return !!row;
  }

  getEventByMessageId(messageId: string, threadId: string): Event | null {
    const row = this.db.db.prepare(
      "SELECT * FROM events WHERE message_id = ? AND thread_id = ?"
    ).get(messageId, threadId) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  getEventById(id: string): Event | null {
    const row = this.db.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
    return row ? toEvent(row) : null;
  }

  getEventsForThread(threadId: string): Event[] {
    const rows = this.db.db
      .prepare("SELECT * FROM events WHERE thread_id = ? ORDER BY timestamp ASC")
      .all(threadId) as EventRow[];
    return rows.map(toEvent);
  }

  getEventsForWorkItem(workItemId: string): Event[] {
    // Include events directly tagged with this work item ID, plus events
    // from threads linked to this work item (which may have been classified
    // under a different work item ID due to LLM/regex ID mismatches).
    const rows = this.db.db
      .prepare(`
        SELECT e.* FROM events e
        WHERE e.work_item_id = ?
           OR e.thread_id IN (SELECT id FROM threads WHERE work_item_id = ?)
        ORDER BY e.timestamp ASC, e.rowid ASC
      `)
      .all(workItemId, workItemId) as EventRow[];
    return rows.map(toEvent);
  }

  // --- Enrichments ---

  upsertEnrichment(enrichment: {
    workItemId: string;
    source: string;
    data: Record<string, unknown>;
  }): Enrichment {
    const id = randomUUID();
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(enrichment.data);

    const stmt = this.db.db.prepare(`
      INSERT INTO enrichments (id, work_item_id, source, data, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        fetched_at = excluded.fetched_at
    `);
    stmt.run(id, enrichment.workItemId, enrichment.source, dataJson, now);
    log.debug("Upserted enrichment for work item", enrichment.workItemId);

    const row = this.db.db.prepare("SELECT * FROM enrichments WHERE id = ?").get(id) as
      | EnrichmentRow
      | undefined;
    return row ? toEnrichment(row) : { id, ...enrichment, fetchedAt: now };
  }

  getEnrichmentsForWorkItem(workItemId: string): Enrichment[] {
    const rows = this.db.db
      .prepare("SELECT * FROM enrichments WHERE work_item_id = ? ORDER BY fetched_at DESC")
      .all(workItemId) as EnrichmentRow[];
    return rows.map(toEnrichment);
  }

  // --- Poll Cursors ---

  getPollCursor(channelId: string): PollCursor | null {
    const row = this.db.db
      .prepare("SELECT * FROM poll_cursors WHERE channel_id = ?")
      .get(channelId) as PollCursorRow | undefined;
    return row ? toPollCursor(row) : null;
  }

  setPollCursor(channelId: string, lastTimestamp: string): PollCursor {
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT INTO poll_cursors (channel_id, last_timestamp, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_timestamp = excluded.last_timestamp,
        updated_at = excluded.updated_at
    `);
    stmt.run(channelId, lastTimestamp, now);
    log.debug("Set poll cursor for channel", channelId);

    return this.getPollCursor(channelId)!;
  }

  // --- Summaries ---

  getSummary(workItemId: string): { workItemId: string; summaryText: string; generatedAt: string; latestEventId: string } | null {
    const row = this.db.db
      .prepare("SELECT * FROM summaries WHERE work_item_id = ?")
      .get(workItemId) as SummaryRow | undefined;
    return row ? toSummary(row) : null;
  }

  upsertSummary(summary: {
    workItemId: string;
    summaryText: string;
    latestEventId: string;
  }): void {
    const now = new Date().toISOString();
    this.db.db.prepare(`
      INSERT INTO summaries (work_item_id, summary_text, generated_at, latest_event_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        generated_at = excluded.generated_at,
        latest_event_id = excluded.latest_event_id
    `).run(summary.workItemId, summary.summaryText, now, summary.latestEventId);
  }

  // --- Open Work Item Summaries (for classifier dedup) ---

  getOpenWorkItemSummaries(): Array<{ id: string; title: string }> {
    const rows = this.db.db
      .prepare(`
        SELECT id, title FROM work_items
        WHERE current_atc_status NOT IN ('completed', 'noise')
           OR current_atc_status IS NULL
        ORDER BY updated_at DESC
        LIMIT 100
      `)
      .all() as Array<{ id: string; title: string }>;
    return rows;
  }

  // --- Sidekick query methods ---

  searchWorkItems(query: string): WorkItem[] {
    const pattern = `%${query}%`;
    const rows = this.db.db
      .prepare("SELECT * FROM work_items WHERE id LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT 20")
      .all(pattern, pattern) as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  getWorkItemsByAgent(agentId: string): WorkItem[] {
    const rows = this.db.db
      .prepare(`
        SELECT DISTINCT wi.* FROM work_items wi
        INNER JOIN events e ON e.work_item_id = wi.id
        WHERE e.agent_id = ?
        ORDER BY wi.updated_at DESC
        LIMIT 20
      `)
      .all(agentId) as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  getEventsSince(since: Date): Event[] {
    const rows = this.db.db
      .prepare("SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp ASC LIMIT 100")
      .all(since.toISOString()) as EventRow[];
    return rows.map(toEvent);
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.db
      .prepare("SELECT * FROM agents WHERE name LIKE ? LIMIT 1")
      .get(`%${name}%`) as AgentRow | undefined;
    return row ? toAgent(row) : null;
  }

  getFleetStats(): Record<string, number> {
    const rows = this.db.db
      .prepare(`
        SELECT current_atc_status AS status, COUNT(*) AS count
        FROM work_items
        GROUP BY current_atc_status
      `)
      .all() as Array<{ status: string | null; count: number }>;

    const stats: Record<string, number> = { total: 0 };
    for (const row of rows) {
      const key = row.status ?? "unknown";
      stats[key] = row.count;
      stats.total += row.count;
    }
    return stats;
  }

  // --- Stream helpers ---

  getAgentsForWorkItem(workItemId: string): Agent[] {
    const rows = this.db.db
      .prepare(`
        SELECT DISTINCT a.* FROM agents a
        INNER JOIN events e ON e.agent_id = a.id
        WHERE e.work_item_id = ?
        ORDER BY a.last_seen DESC
      `)
      .all(workItemId) as AgentRow[];
    return rows.map(toAgent);
  }

  getChannelsForWorkItem(workItemId: string): Array<{ id: string; name: string }> {
    const rows = this.db.db
      .prepare(`
        SELECT DISTINCT t.channel_id AS id, t.channel_name AS name
        FROM threads t
        WHERE t.work_item_id = ?
        ORDER BY t.last_activity DESC
      `)
      .all(workItemId) as Array<{ id: string; name: string }>;
    return rows;
  }

  // --- Actionable Items ---

  getFleetItems(): ActionableItem[] {
    const rows = this.db.db
      .prepare(
        `
      SELECT
        wi.*,
        e.id AS e_id, e.thread_id AS e_thread_id, e.message_id AS e_message_id,
        e.work_item_id AS e_work_item_id, e.agent_id AS e_agent_id,
        e.status AS e_status, e.confidence AS e_confidence, e.reason AS e_reason,
        e.raw_text AS e_raw_text, e.timestamp AS e_timestamp, e.created_at AS e_created_at,
        e.entry_type AS e_entry_type,
        e.targeted_at_operator AS e_targeted_at_operator,
        e.action_required_from AS e_action_required_from,
        e.next_action AS e_next_action,
        a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
        a.platform_user_id AS a_platform_user_id, a.role AS a_role,
        a.avatar_url AS a_avatar_url, a.is_bot AS a_is_bot,
        a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
        t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
        t.platform_meta AS t_platform_meta,
        t.platform AS t_platform, t.work_item_id AS t_work_item_id,
        t.last_activity AS t_last_activity, t.message_count AS t_message_count
      FROM work_items wi
      LEFT JOIN events e ON e.id = (
          SELECT e2.id FROM events e2
          LEFT JOIN threads t2 ON e2.thread_id = t2.id
          WHERE e2.work_item_id = wi.id
             OR t2.work_item_id = wi.id
          ORDER BY e2.timestamp DESC
          LIMIT 1
        )
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN threads t ON e.thread_id = t.id
      WHERE wi.current_atc_status IS NULL
         OR wi.current_atc_status != 'completed'
      ORDER BY
        CASE wi.current_atc_status
          WHEN 'blocked_on_human' THEN 0
          WHEN 'needs_decision' THEN 1
          WHEN 'in_progress' THEN 2
          ELSE 3
        END,
        wi.updated_at DESC
    `,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapActionableRow);
  }

  getActionableItems(): ActionableItem[] {
    const rows = this.db.db
      .prepare(
        `
      SELECT
        wi.*,
        e.id AS e_id, e.thread_id AS e_thread_id, e.message_id AS e_message_id,
        e.work_item_id AS e_work_item_id, e.agent_id AS e_agent_id,
        e.status AS e_status, e.confidence AS e_confidence, e.reason AS e_reason,
        e.raw_text AS e_raw_text, e.timestamp AS e_timestamp, e.created_at AS e_created_at,
        e.entry_type AS e_entry_type,
        e.targeted_at_operator AS e_targeted_at_operator,
        e.action_required_from AS e_action_required_from,
        e.next_action AS e_next_action,
        a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
        a.platform_user_id AS a_platform_user_id, a.role AS a_role,
        a.avatar_url AS a_avatar_url, a.is_bot AS a_is_bot,
        a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
        t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
        t.platform_meta AS t_platform_meta,
        t.platform AS t_platform, t.work_item_id AS t_work_item_id,
        t.last_activity AS t_last_activity, t.message_count AS t_message_count
      FROM work_items wi
      INNER JOIN events e ON e.work_item_id = wi.id
        AND e.id = (
          SELECT e2.id FROM events e2
          WHERE e2.work_item_id = wi.id
          ORDER BY e2.timestamp DESC
          LIMIT 1
        )
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN threads t ON e.thread_id = t.id
      WHERE wi.current_atc_status IN ('blocked_on_human', 'needs_decision')
        AND (wi.snoozed_until IS NULL OR wi.snoozed_until <= datetime('now'))
        AND e.targeted_at_operator = 1
      ORDER BY
        CASE wi.current_atc_status
          WHEN 'blocked_on_human' THEN 0
          WHEN 'needs_decision' THEN 1
        END,
        e.timestamp DESC
    `,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapActionableRow);
  }

  getRecentItems(limit: number): ActionableItem[] {
    const rows = this.db.db
      .prepare(
        `
      SELECT
        wi.*,
        e.id AS e_id, e.thread_id AS e_thread_id, e.message_id AS e_message_id,
        e.work_item_id AS e_work_item_id, e.agent_id AS e_agent_id,
        e.status AS e_status, e.confidence AS e_confidence, e.reason AS e_reason,
        e.raw_text AS e_raw_text, e.timestamp AS e_timestamp, e.created_at AS e_created_at,
        e.entry_type AS e_entry_type,
        e.targeted_at_operator AS e_targeted_at_operator,
        e.action_required_from AS e_action_required_from,
        e.next_action AS e_next_action,
        a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
        a.platform_user_id AS a_platform_user_id, a.role AS a_role,
        a.avatar_url AS a_avatar_url, a.is_bot AS a_is_bot,
        a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
        t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
        t.platform_meta AS t_platform_meta,
        t.platform AS t_platform, t.work_item_id AS t_work_item_id,
        t.last_activity AS t_last_activity, t.message_count AS t_message_count
      FROM work_items wi
      LEFT JOIN events e ON e.id = (
          SELECT e2.id FROM events e2
          LEFT JOIN threads t2 ON e2.thread_id = t2.id
          WHERE e2.work_item_id = wi.id
             OR t2.work_item_id = wi.id
          ORDER BY e2.timestamp DESC
          LIMIT 1
        )
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN threads t ON e.thread_id = t.id
      WHERE wi.current_atc_status IS NULL
         OR wi.current_atc_status NOT IN ('completed', 'noise')
      ORDER BY wi.updated_at DESC
      LIMIT ?
    `,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(mapActionableRow);
  }
}

function mapActionableRow(row: Record<string, unknown>): ActionableItem {
  const workItem: WorkItem = {
    id: row.id as string,
    source: row.source as string,
    title: row.title as string,
    externalStatus: row.external_status as string | null,
    assignee: row.assignee as string | null,
    url: row.url as string | null,
    currentAtcStatus: row.current_atc_status as StatusCategory | null,
    currentConfidence: row.current_confidence as number | null,
    snoozedUntil: row.snoozed_until as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };

  let eventActionRequiredFrom: string[] | null = null;
  if (row.e_action_required_from) {
    try {
      eventActionRequiredFrom = JSON.parse(row.e_action_required_from as string);
    } catch {
      eventActionRequiredFrom = null;
    }
  }

  const latestEvent: Event = {
    id: row.e_id as string,
    threadId: row.e_thread_id as string,
    messageId: row.e_message_id as string,
    workItemId: row.e_work_item_id as string | null,
    agentId: row.e_agent_id as string | null,
    status: row.e_status as StatusCategory,
    confidence: row.e_confidence as number,
    reason: row.e_reason as string,
    rawText: row.e_raw_text as string,
    timestamp: row.e_timestamp as string,
    createdAt: row.e_created_at as string,
    entryType: (row.e_entry_type as EntryType) ?? "progress",
    targetedAtOperator: Boolean(row.e_targeted_at_operator ?? 1),
    actionRequiredFrom: eventActionRequiredFrom,
    nextAction: (row.e_next_action as string | null) ?? null,
  };

  const aIsBot = row.a_is_bot as number | null | undefined;
  const agent: Agent | null = row.a_id
    ? {
        id: row.a_id as string,
        name: row.a_name as string,
        platform: row.a_platform as string,
        platformUserId: row.a_platform_user_id as string,
        role: row.a_role as string | null,
        avatarUrl: (row.a_avatar_url as string | null) ?? null,
        isBot: aIsBot != null ? aIsBot === 1 : null,
        firstSeen: row.a_first_seen as string,
        lastSeen: row.a_last_seen as string,
      }
    : null;

  const thread: Thread | null = row.t_id
    ? {
        id: row.t_id as string,
        channelId: row.t_channel_id as string,
        channelName: row.t_channel_name as string,
        platformMeta: row.t_platform_meta ? JSON.parse(row.t_platform_meta as string) : undefined,
        platform: row.t_platform as string,
        workItemId: row.t_work_item_id as string | null,
        lastActivity: row.t_last_activity as string,
        messageCount: row.t_message_count as number,
        messages: [],
      }
    : null;

  return { workItem, latestEvent, agent, thread };
}
