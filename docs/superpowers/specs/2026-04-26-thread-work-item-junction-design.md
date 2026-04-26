# Thread-Work Item Junction Table Design

## Goal

Replace the 1:1 `threads.work_item_id` relationship with an M:N junction table, eliminate breakdown event duplication, and make the timeline data-driven by relation type.

## Problem

The current graph forces a single `work_item_id` per thread, but reality is M:N — summary messages discuss multiple work items, and a work item can span multiple threads. The workaround (breakdown events) duplicates the full message text into separate events per work item, causing:

- **Timeline noise**: Every mentioned work item gets the full summary message in its timeline
- **Hallucination risk**: Breakdown work item IDs come from the LLM and can be fabricated
- **Thread lookup failures**: Work items that only appear through breakdowns have no thread linkage, causing 500 errors in the action handler
- **Band-aids**: `FocusedMessage` (regex-based line dimming), `findThreadForWorkItem` (event-scanning fallback)

## Design

### Schema

New junction table:

```sql
CREATE TABLE thread_work_items (
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  work_item_id  TEXT NOT NULL REFERENCES work_items(id),
  relation      TEXT NOT NULL DEFAULT 'mentioned',  -- 'primary' | 'mentioned'
  created_at    TEXT NOT NULL,
  PRIMARY KEY (thread_id, work_item_id)
);

CREATE INDEX idx_twi_work_item ON thread_work_items(work_item_id);
```

Relation types:
- **`primary`**: The thread is directly about this work item (e.g., the AI-279 LinkedIn draft thread)
- **`mentioned`**: The thread mentions this work item in passing (e.g., a sprint plan listing AI-279 among 12 items)

`threads.work_item_id` remains as a denormalized shortcut (always the `primary` work item), kept in sync by the pipeline. This avoids a mass query rewrite — it can be deprecated later.

### Pipeline changes

**Breakdown events are eliminated.** Today, `pipeline.ts` creates a separate event per work item from the classifier's breakdown array. After the change:

- One event is stored per message (the existing "primary" event). Its `work_item_id` is the primary work item (first extracted ID, or inherited from the thread).
- The classifier's per-item breakdown statuses are still used to update each work item's `current_atc_status` via `upsertWorkItem` — this logic stays.
- The breakdown work item IDs are written to `thread_work_items` as `mentioned` entries instead of being turned into duplicate events.

**Thread linking becomes junction-based.** Today, `linker.ts` sets `threads.work_item_id` to the first extracted ID. After the change:

- The linker writes a row to `thread_work_items` for every extracted ID.
- The first extracted ID gets `relation = 'primary'`; the rest get `mentioned`.
- `threads.work_item_id` is kept in sync (set to the primary) for backwards compatibility.

**LLM-suggested IDs** that pass validation (checked against known prefixes) are also written to the junction table as `mentioned`.

### Stream API & Timeline

**Timeline query.** `getEventsForWorkItemPaginated` changes from:

```sql
WHERE (e.work_item_id = ? OR t.work_item_id = ?)
```

to:

```sql
WHERE e.work_item_id = ?
   OR e.thread_id IN (SELECT thread_id FROM thread_work_items WHERE work_item_id = ?)
```

**Timeline entries gain a `relation` field.** Each `TimelineEntry` gets `relation: 'primary' | 'mentioned'`. Determined by: if the event's own `work_item_id` matches, it's `primary`; if it came in via the junction join, it's `mentioned`.

**UI rendering by relation type:**
- `primary`: Renders as today — full message, full opacity
- `mentioned`: Renders collapsed — shows only the classifier's reason/summary line. Full message expandable on click.

This replaces `FocusedMessage` with a data-driven approach.

**`getThreadsForWorkItem` and `getChannelsForWorkItem`** switch to querying the junction table, preferring `primary` relations.

### Action handler

The `findThreadForWorkItem` helper is replaced with a junction table query:

```sql
SELECT t.* FROM threads t
JOIN thread_work_items twi ON twi.thread_id = t.id
WHERE twi.work_item_id = ?
ORDER BY CASE twi.relation WHEN 'primary' THEN 0 ELSE 1 END, t.last_activity DESC
LIMIT 1
```

Prefers `primary` threads, falls back to `mentioned`. No more event-scanning fallback.

### Migration

Run once during `db.migrate()`:

1. **Backfill junction rows from existing data:**
   - Each thread with a non-null `work_item_id` becomes a `primary` junction row.
   - Each event whose `work_item_id` differs from its thread's `work_item_id` becomes a `mentioned` junction row (these are today's breakdown events).

2. **Delete breakdown event duplicates.** Events where `message_id` contains `:` (the `${messageId}:${workItemId}` pattern from the breakdown path) are duplicates of the parent event. Delete them.

3. **Create index** on `thread_work_items(work_item_id)` for reverse lookups.

### Code removed after migration

- `FocusedMessage` component in `Timeline.tsx`
- `findThreadForWorkItem` helper in `server.ts`
- Breakdown event creation block in `pipeline.ts` (the `insertEvent` inside the breakdown loop)
- Validated breakdown filtering added for the AI-401 fix (no longer needed)
- `TICKET_ID_RE` regex and line-splitting logic in `Timeline.tsx`

### Testing

- **Migration test**: Seed a database with breakdown events, run migration, verify junction rows exist and breakdown events are deleted.
- **Pipeline test**: Process a summary message mentioning 3 work items. Verify: one event stored, three junction rows created, each work item's status updated.
- **Timeline test**: Fetch stream for a work item with both `primary` and `mentioned` events. Verify relation field is set correctly on each timeline entry.
- **Action handler test**: Call unblock on a work item that only has `mentioned` junction rows (no `primary`). Verify it finds the thread and succeeds.
- **Linker test**: Extract IDs from message text. Verify junction rows created with correct relation types.
