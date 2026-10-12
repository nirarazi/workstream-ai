// core/eval/context.ts — Work item and thread context for an eval item, read from workstream.db
//
// A message alone often can't be labeled: "approved, go ahead" means nothing without the ticket and
// the messages around it. The labeler shows this context; the dataset only stores events.id.

import type BetterSqlite3 from "better-sqlite3";

export interface ContextWorkItem {
  id: string;
  title: string;
  status: string | null;
  assignee: string | null;
  url: string | null;
}

export interface ContextMessage {
  sender: string;
  timestamp: string;
  text: string;
}

export interface ItemContext {
  workItems: ContextWorkItem[];
  /** First message of the thread, when it isn't already in `before`. */
  root: ContextMessage | null;
  before: ContextMessage[];
  after: ContextMessage[];
}

interface EventRow {
  thread_id: string;
  work_item_id: string | null;
  timestamp: string;
}

interface WorkItemRow {
  id: string;
  title: string;
  external_status: string | null;
  assignee: string | null;
  url: string | null;
  jira: string | null;
}

export function loadItemContext(
  db: BetterSqlite3.Database,
  eventId: string,
  window = { before: 4, after: 2 },
): ItemContext | null {
  const event = db.prepare("SELECT thread_id, work_item_id, timestamp FROM events WHERE id = ?").get(eventId) as EventRow | undefined;
  if (!event) return null;

  // The event's own work item first, then any other item linked to the thread.
  const rows = db.prepare(`
    SELECT w.id, w.title, w.external_status, w.assignee, w.url,
           (SELECT data FROM enrichments en WHERE en.work_item_id = w.id AND en.source = 'jira'
            ORDER BY fetched_at DESC LIMIT 1) AS jira
    FROM work_items w
    WHERE w.id = ? OR w.id IN (SELECT work_item_id FROM thread_work_items WHERE thread_id = ?)
    ORDER BY w.id = ? DESC
  `).all(event.work_item_id, event.thread_id, event.work_item_id) as WorkItemRow[];

  const workItems = rows.map((r): ContextWorkItem => {
    const jira = r.jira ? (JSON.parse(r.jira) as { title?: string; status?: string; assignee?: string; url?: string }) : {};
    return {
      // Inferred items are keyed by thread ("thread:1777…"); the title is what identifies them.
      id: r.id,
      title: jira.title || r.title,
      status: jira.status ?? r.external_status,
      assignee: jira.assignee ?? r.assignee,
      url: jira.url ?? r.url,
    };
  });

  const messages = db.prepare(`
    SELECT COALESCE(a.name, 'unknown') AS sender, e.timestamp, e.raw_text AS text
    FROM events e LEFT JOIN agents a ON a.id = e.agent_id
    WHERE e.thread_id = ? AND e.id != ? AND length(trim(e.raw_text)) > 0
    GROUP BY e.message_id
    ORDER BY e.timestamp
  `).all(event.thread_id, eventId) as ContextMessage[];

  const earlier = messages.filter((m) => m.timestamp < event.timestamp);
  const before = earlier.slice(-window.before);
  return {
    workItems,
    root: earlier.length > before.length ? earlier[0] : null,
    before,
    after: messages.filter((m) => m.timestamp > event.timestamp).slice(0, window.after),
  };
}
