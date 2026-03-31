// core/graph/index.ts — ContextGraph: main API for all database operations

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type {
  ActionableItem,
  Agent,
  Enrichment,
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
    platform: row.platform,
    workItemId: row.work_item_id,
    lastActivity: row.last_activity,
    messageCount: row.message_count,
    messages: [],
  };
}

function toEvent(row: EventRow): Event {
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
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    role: row.role,
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
  }): Agent {
    const now = new Date().toISOString();
    const id = agent.id ?? randomUUID();

    const stmt = this.db.db.prepare(`
      INSERT INTO agents (id, name, platform, platform_user_id, role, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        platform_user_id = excluded.platform_user_id,
        role = COALESCE(excluded.role, agents.role),
        last_seen = excluded.last_seen
    `);
    stmt.run(id, agent.name, agent.platform, agent.platformUserId, agent.role ?? null, now, now);
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
    platform: string;
    workItemId?: string | null;
    lastActivity?: string;
    messageCount?: number;
  }): Thread {
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT INTO threads (id, channel_id, channel_name, platform, work_item_id, last_activity, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        channel_name = CASE WHEN excluded.channel_name = '' THEN threads.channel_name ELSE excluded.channel_name END,
        platform = excluded.platform,
        work_item_id = COALESCE(excluded.work_item_id, threads.work_item_id),
        last_activity = excluded.last_activity,
        message_count = CASE WHEN excluded.message_count > threads.message_count THEN excluded.message_count ELSE threads.message_count END
    `);
    stmt.run(
      thread.id,
      thread.channelId,
      thread.channelName ?? "",
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

  // --- Events ---

  insertEvent(event: {
    threadId: string;
    messageId: string;
    workItemId?: string | null;
    agentId?: string | null;
    status: StatusCategory;
    confidence: number;
    reason?: string;
    rawText?: string;
    timestamp: string;
  }): Event {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.db.prepare(`
      INSERT INTO events (id, thread_id, message_id, work_item_id, agent_id, status, confidence, reason, raw_text, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
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
    );
    log.debug("Inserted event", id);

    return this.getEventById(id)!;
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
    const rows = this.db.db
      .prepare("SELECT * FROM events WHERE work_item_id = ? ORDER BY timestamp ASC")
      .all(workItemId) as EventRow[];
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

  // --- Actionable Items ---

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
        a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
        a.platform_user_id AS a_platform_user_id, a.role AS a_role,
        a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
        t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
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
        a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
        a.platform_user_id AS a_platform_user_id, a.role AS a_role,
        a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
        t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
        t.platform AS t_platform, t.work_item_id AS t_work_item_id,
        t.last_activity AS t_last_activity, t.message_count AS t_message_count
      FROM work_items wi
      LEFT JOIN events e ON e.work_item_id = wi.id
        AND e.id = (
          SELECT e2.id FROM events e2
          WHERE e2.work_item_id = wi.id
          ORDER BY e2.timestamp DESC
          LIMIT 1
        )
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN threads t ON e.thread_id = t.id
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
  };

  const agent: Agent | null = row.a_id
    ? {
        id: row.a_id as string,
        name: row.a_name as string,
        platform: row.a_platform as string,
        platformUserId: row.a_platform_user_id as string,
        role: row.a_role as string | null,
        firstSeen: row.a_first_seen as string,
        lastSeen: row.a_last_seen as string,
      }
    : null;

  const thread: Thread | null = row.t_id
    ? {
        id: row.t_id as string,
        channelId: row.t_channel_id as string,
        channelName: row.t_channel_name as string,
        platform: row.t_platform as string,
        workItemId: row.t_work_item_id as string | null,
        lastActivity: row.t_last_activity as string,
        messageCount: row.t_message_count as number,
        messages: [],
      }
    : null;

  return { workItem, latestEvent, agent, thread };
}
