# Thread-Work Item Junction Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1:1 `threads.work_item_id` relationship with an M:N junction table, eliminate breakdown event duplication, and make timeline rendering data-driven by relation type.

**Architecture:** New `thread_work_items` junction table with `primary`/`mentioned` relation types. Pipeline stops creating duplicate breakdown events; writes junction rows instead. Stream API and action handler query junction table for thread/work-item lookups. `threads.work_item_id` kept in sync as a denormalized shortcut for backwards compatibility.

**Tech Stack:** SQLite (better-sqlite3), TypeScript, Vitest, React + Tailwind

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `core/graph/db.ts` | Modify | Add junction table creation + backfill migration |
| `core/graph/index.ts` | Modify | Add junction CRUD methods, update query methods |
| `core/graph/linker.ts` | Modify | Write junction rows instead of only setting `threads.work_item_id` |
| `core/pipeline.ts` | Modify | Remove breakdown event creation, write junction rows |
| `core/stream.ts` | Modify | Add `relation` field to `TimelineEntry` |
| `core/server.ts` | Modify | Replace `findThreadForWorkItem` with junction query, update stream route |
| `core/types.ts` | Modify | Add `ThreadWorkItem` type |
| `src/components/stream/Timeline.tsx` | Modify | Replace `FocusedMessage` with relation-based rendering |
| `src/lib/api.ts` | Modify | Add `relation` to frontend `TimelineEntry` type |
| `tests/graph/junction.test.ts` | Create | Junction table CRUD + migration tests |
| `tests/graph/linker.test.ts` | Modify | Add junction row assertions |
| `tests/core/pipeline.test.ts` | Modify | Verify junction rows instead of breakdown events |
| `tests/server/stream-api.test.ts` | Modify | Verify relation field in timeline entries |

---

### Task 1: Schema — Create Junction Table

**Files:**
- Modify: `core/graph/db.ts:11-101` (SCHEMA_SQL)
- Modify: `core/types.ts` (add ThreadWorkItem type)
- Test: `tests/graph/junction.test.ts` (create)

- [ ] **Step 1: Write the failing test for junction table existence**

Create `tests/graph/junction.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("thread_work_items junction table", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates thread_work_items table with correct columns", () => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("thread_work_items");

    const cols = db.db.pragma("table_info(thread_work_items)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("thread_id");
    expect(colNames).toContain("work_item_id");
    expect(colNames).toContain("relation");
    expect(colNames).toContain("created_at");
  });

  it("has index on work_item_id for reverse lookups", () => {
    const indices = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='thread_work_items'")
      .all() as Array<{ name: string }>;
    const names = indices.map((i) => i.name);
    expect(names.some((n) => n.includes("work_item"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: FAIL — table `thread_work_items` does not exist

- [ ] **Step 3: Add the junction table to SCHEMA_SQL and type**

In `core/graph/db.ts`, add after the `llm_usage` table (before the CREATE INDEX block):

```sql
CREATE TABLE IF NOT EXISTS thread_work_items (
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  work_item_id  TEXT NOT NULL REFERENCES work_items(id),
  relation      TEXT NOT NULL DEFAULT 'mentioned',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (thread_id, work_item_id)
);
```

Add after the existing `CREATE INDEX` block:

```sql
CREATE INDEX IF NOT EXISTS idx_twi_work_item ON thread_work_items(work_item_id);
```

In `core/types.ts`, add the type:

```typescript
export interface ThreadWorkItem {
  threadId: string;
  workItemId: string;
  relation: "primary" | "mentioned";
  createdAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/db.ts core/types.ts tests/graph/junction.test.ts
git commit -m "feat: add thread_work_items junction table schema"
```

---

### Task 2: Graph — Junction CRUD Methods

**Files:**
- Modify: `core/graph/index.ts`
- Modify: `core/graph/schema.ts` (add row type)
- Test: `tests/graph/junction.test.ts`

- [ ] **Step 1: Write failing tests for junction CRUD**

Append to `tests/graph/junction.test.ts`:

```typescript
describe("junction CRUD", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    // Seed data
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Item 100" });
    graph.upsertWorkItem({ id: "AI-200", source: "jira", title: "Item 200" });
    graph.upsertThread({
      id: "T1", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
  });

  afterEach(() => { db.close(); });

  it("linkThreadWorkItem creates a junction row", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const rows = graph.getWorkItemsForThread("T1");
    expect(rows).toHaveLength(1);
    expect(rows[0].workItemId).toBe("AI-100");
    expect(rows[0].relation).toBe("primary");
  });

  it("linkThreadWorkItem is idempotent (upsert)", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "mentioned");
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const rows = graph.getWorkItemsForThread("T1");
    expect(rows).toHaveLength(1);
    expect(rows[0].relation).toBe("primary");
  });

  it("getThreadsForWorkItemViaJunction returns threads", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    const threads = graph.getThreadsForWorkItemViaJunction("AI-100");
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("T1");
  });

  it("getThreadsForWorkItemViaJunction prefers primary over mentioned", () => {
    graph.upsertThread({
      id: "T2", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
    graph.linkThreadWorkItem("T1", "AI-100", "mentioned");
    graph.linkThreadWorkItem("T2", "AI-100", "primary");
    const threads = graph.getThreadsForWorkItemViaJunction("AI-100");
    // Primary thread should come first
    expect(threads[0].id).toBe("T2");
  });

  it("getWorkItemsForThread returns all linked items", () => {
    graph.linkThreadWorkItem("T1", "AI-100", "primary");
    graph.linkThreadWorkItem("T1", "AI-200", "mentioned");
    const items = graph.getWorkItemsForThread("T1");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.workItemId).sort()).toEqual(["AI-100", "AI-200"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: FAIL — methods don't exist yet

- [ ] **Step 3: Add junction row type to schema.ts**

In `core/graph/schema.ts`, add:

```typescript
export interface ThreadWorkItemRow {
  thread_id: string;
  work_item_id: string;
  relation: string;
  created_at: string;
}
```

- [ ] **Step 4: Implement junction CRUD in index.ts**

In `core/graph/index.ts`, add these methods (after the thread methods section, around line 507):

```typescript
// --- Thread-Work Item Junction ---

linkThreadWorkItem(threadId: string, workItemId: string, relation: "primary" | "mentioned"): void {
  this.db.db.prepare(`
    INSERT INTO thread_work_items (thread_id, work_item_id, relation, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id, work_item_id) DO UPDATE SET
      relation = excluded.relation
  `).run(threadId, workItemId, relation, new Date().toISOString());
}

getWorkItemsForThread(threadId: string): ThreadWorkItem[] {
  const rows = this.db.db
    .prepare("SELECT * FROM thread_work_items WHERE thread_id = ? ORDER BY relation ASC")
    .all(threadId) as ThreadWorkItemRow[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    workItemId: r.work_item_id,
    relation: r.relation as "primary" | "mentioned",
    createdAt: r.created_at,
  }));
}

getThreadsForWorkItemViaJunction(workItemId: string): Thread[] {
  const rows = this.db.db
    .prepare(`
      SELECT t.* FROM threads t
      JOIN thread_work_items twi ON twi.thread_id = t.id
      WHERE twi.work_item_id = ?
      ORDER BY CASE twi.relation WHEN 'primary' THEN 0 ELSE 1 END, t.last_activity DESC
    `)
    .all(workItemId) as ThreadRow[];
  return rows.map(toThread);
}
```

Add the necessary imports at the top of `index.ts`:

```typescript
import type { ThreadWorkItemRow } from "./schema.js";
import type { ThreadWorkItem } from "../types.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/graph/index.ts core/graph/schema.ts tests/graph/junction.test.ts
git commit -m "feat: add junction table CRUD methods"
```

---

### Task 3: Migration — Backfill Junction Rows and Delete Breakdown Events

**Files:**
- Modify: `core/graph/db.ts:134-280` (migrate method)
- Test: `tests/graph/junction.test.ts`

- [ ] **Step 1: Write failing test for migration backfill**

Append to `tests/graph/junction.test.ts`:

```typescript
describe("migration backfill", () => {
  it("backfills junction rows from existing threads and deletes breakdown events", () => {
    // Create a fresh DB and manually insert pre-migration data
    // (bypassing the migration by inserting directly)
    const db = new Database(":memory:");

    // Seed: work items
    db.db.prepare("INSERT INTO work_items (id, source, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("AI-100", "jira", "Item 100", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.db.prepare("INSERT INTO work_items (id, source, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("AI-200", "jira", "Item 200", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

    // Seed: thread linked to AI-100
    db.db.prepare("INSERT INTO threads (id, channel_id, channel_name, platform_meta, platform, work_item_id, last_activity, message_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("T1", "C1", "general", "{}", "slack", "AI-100", "2026-01-01T00:00:00Z", 1);

    // Seed: primary event
    db.db.prepare("INSERT INTO events (id, thread_id, message_id, work_item_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type, targeted_at_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("evt1", "T1", "msg1", "AI-100", "in_progress", 0.9, "reason", "text", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "progress", 1);

    // Seed: breakdown event (message_id contains ':')
    db.db.prepare("INSERT INTO events (id, thread_id, message_id, work_item_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type, targeted_at_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("evt2", "T1", "msg1:AI-200", "AI-200", "blocked_on_human", 0.8, "reason", "text", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "block", 1);

    // Verify breakdown event exists before migration runs
    const beforeCount = (db.db.prepare("SELECT COUNT(*) AS n FROM thread_work_items").get() as { n: number }).n;

    // The migration runs during Database construction, so junction rows should
    // already be populated. Check:
    const junctionRows = db.db.prepare("SELECT * FROM thread_work_items ORDER BY work_item_id").all() as Array<{
      thread_id: string;
      work_item_id: string;
      relation: string;
    }>;

    // Should have backfilled: T1→AI-100 (primary), T1→AI-200 (mentioned via breakdown event)
    expect(junctionRows.length).toBeGreaterThanOrEqual(1);
    const ai100Row = junctionRows.find((r) => r.work_item_id === "AI-100");
    expect(ai100Row).toBeDefined();
    expect(ai100Row!.relation).toBe("primary");

    const ai200Row = junctionRows.find((r) => r.work_item_id === "AI-200");
    expect(ai200Row).toBeDefined();
    expect(ai200Row!.relation).toBe("mentioned");

    // Breakdown events should be deleted
    const breakdownEvents = db.db
      .prepare("SELECT * FROM events WHERE message_id LIKE '%:%'")
      .all();
    expect(breakdownEvents).toHaveLength(0);

    // Primary event should still exist
    const primaryEvents = db.db.prepare("SELECT * FROM events WHERE id = 'evt1'").all();
    expect(primaryEvents).toHaveLength(1);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: FAIL — no junction rows backfilled, breakdown events not deleted

- [ ] **Step 3: Implement the migration in db.ts**

Add at the end of the `migrate()` method in `core/graph/db.ts`:

```typescript
// Backfill thread_work_items junction table from existing data
const twiExists = this.db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='thread_work_items'"
).get() as { name: string } | undefined;
if (twiExists) {
  const junctionCount = (this.db.prepare("SELECT COUNT(*) AS n FROM thread_work_items").get() as { n: number }).n;
  if (junctionCount === 0) {
    // Step 1: Backfill primary rows from threads.work_item_id
    const primaryResult = this.db.prepare(`
      INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
      SELECT id, work_item_id, 'primary', last_activity
      FROM threads
      WHERE work_item_id IS NOT NULL
    `).run();
    log.info(`Migration: backfilled ${primaryResult.changes} primary junction rows from threads`);

    // Step 2: Backfill mentioned rows from events with different work_item_id
    const mentionedResult = this.db.prepare(`
      INSERT OR IGNORE INTO thread_work_items (thread_id, work_item_id, relation, created_at)
      SELECT e.thread_id, e.work_item_id, 'mentioned', e.timestamp
      FROM events e
      JOIN threads t ON e.thread_id = t.id
      WHERE e.work_item_id IS NOT NULL
        AND e.work_item_id != COALESCE(t.work_item_id, '')
    `).run();
    log.info(`Migration: backfilled ${mentionedResult.changes} mentioned junction rows from events`);

    // Step 3: Delete breakdown event duplicates (message_id contains ':')
    const breakdownResult = this.db.prepare(`
      DELETE FROM events WHERE message_id LIKE '%:%'
        AND message_id != id
    `).run();
    log.info(`Migration: deleted ${breakdownResult.changes} breakdown duplicate events`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/junction.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add core/graph/db.ts tests/graph/junction.test.ts
git commit -m "feat: backfill junction rows from existing data, delete breakdown events"
```

---

### Task 4: Linker — Write Junction Rows

**Files:**
- Modify: `core/graph/linker.ts`
- Test: `tests/graph/linker.test.ts`

- [ ] **Step 1: Write failing test for junction row creation in linker**

Add to `tests/graph/linker.test.ts` (a new `describe` block):

```typescript
describe("junction row creation", () => {
  let db: Database;
  let graph: ContextGraph;
  let linker: WorkItemLinker;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    const extractor = new DefaultExtractor();
    linker = new WorkItemLinker(graph, [extractor]);
    // Seed a thread
    graph.upsertThread({
      id: "T1", channelId: "C1", channelName: "general",
      platform: "slack", lastActivity: new Date().toISOString(),
    });
  });

  afterEach(() => { db.close(); });

  it("creates junction rows for all extracted IDs", () => {
    linker.linkMessage("Working on AI-100 and AI-200 now", "T1");
    const junctions = graph.getWorkItemsForThread("T1");
    expect(junctions).toHaveLength(2);
    // First ID is primary
    const primary = junctions.find((j) => j.relation === "primary");
    expect(primary).toBeDefined();
    expect(primary!.workItemId).toBe("AI-100");
    // Second is mentioned
    const mentioned = junctions.find((j) => j.relation === "mentioned");
    expect(mentioned).toBeDefined();
    expect(mentioned!.workItemId).toBe("AI-200");
  });

  it("still sets threads.work_item_id for backwards compatibility", () => {
    linker.linkMessage("Working on AI-100", "T1");
    const thread = graph.getThreadById("T1");
    expect(thread!.workItemId).toBe("AI-100");
  });
});
```

Adjust imports at the top of the test file as needed (add `Database`, `ContextGraph`, `DefaultExtractor` if not present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/linker.test.ts`
Expected: FAIL — `getWorkItemsForThread` returns empty (linker doesn't write junction rows yet)

- [ ] **Step 3: Modify linker.ts to write junction rows**

Replace the body of `linkMessage` in `core/graph/linker.ts`:

```typescript
linkMessage(text: string, threadId: string): string[] {
  const allIds = new Set<string>();

  for (const extractor of this.extractors) {
    const ids = extractor.extractWorkItemIds(text);
    for (const id of ids) {
      allIds.add(id);
    }
  }

  const workItemIds = Array.from(allIds);

  for (const id of workItemIds) {
    this.graph.upsertWorkItem({ id, source: "extracted" });
    log.debug("Ensured work item exists", id);
  }

  // Write junction rows for all extracted IDs
  for (let i = 0; i < workItemIds.length; i++) {
    const relation = i === 0 ? "primary" : "mentioned";
    this.graph.linkThreadWorkItem(threadId, workItemIds[i], relation);
  }

  // Keep threads.work_item_id in sync (backwards compatibility)
  if (workItemIds.length > 0) {
    const thread = this.graph.getThreadById(threadId);
    if (thread && !thread.workItemId) {
      this.graph.upsertThread({
        id: thread.id,
        channelId: thread.channelId,
        channelName: thread.channelName,
        platform: thread.platform,
        workItemId: workItemIds[0],
        lastActivity: thread.lastActivity,
        messageCount: thread.messageCount,
      });
      log.debug("Linked thread to work item", threadId, workItemIds[0]);
    }
  }

  return workItemIds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/linker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/linker.ts tests/graph/linker.test.ts
git commit -m "feat: linker writes junction rows for all extracted work item IDs"
```

---

### Task 5: Pipeline — Eliminate Breakdown Events, Write Junction Rows

**Files:**
- Modify: `core/pipeline.ts:549-598` (step 6: breakdown event loop)
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write failing test for junction rows in pipeline**

Add a test to `tests/core/pipeline.test.ts` (may need to create the describe block and adjust imports). If the test file already has a helper that sets up a pipeline with mock classifier, extend it. Otherwise add:

```typescript
describe("junction rows from breakdown", () => {
  it("creates junction rows instead of breakdown events for summary messages", async () => {
    // Setup: mock classifier returns breakdown with 3 work items
    // Process the message through the pipeline
    // Assert:
    //   1. Only ONE event stored (the primary event, not one per breakdown item)
    //   2. Junction rows exist for all 3 work items
    //   3. Each work item's status was updated

    // This test's exact setup depends on the existing test infrastructure.
    // Use the existing mock pattern in the file.
    // Key assertion:
    const breakdownEvents = db.db
      .prepare("SELECT * FROM events WHERE message_id LIKE '%:%'")
      .all();
    expect(breakdownEvents).toHaveLength(0); // No breakdown events

    const junctionRows = db.db
      .prepare("SELECT * FROM thread_work_items")
      .all() as Array<{ work_item_id: string; relation: string }>;
    expect(junctionRows.length).toBeGreaterThanOrEqual(3);
  });
});
```

Note: Adapt the test to match the existing mock/stub pattern in `tests/core/pipeline.test.ts`. The key assertions are: no breakdown events created, junction rows present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: FAIL — breakdown events still created, no junction rows

- [ ] **Step 3: Modify pipeline.ts step 6 to write junction rows instead of breakdown events**

In `core/pipeline.ts`, replace step 6 (lines ~543-598). The work item status update logic stays, but the `insertEvent` call inside the breakdown loop is replaced with `linkThreadWorkItem`:

```typescript
// Step 6: Update work item status and write junction rows
const validatedBreakdownMap = new Map(
  (classification.breakdown ?? [])
    .filter((b) => allWorkItemIds.has(b.workItemId))
    .map((b) => [b.workItemId, b]),
);

for (const workItemId of allWorkItemIds) {
  // Write junction row (primary for the first/inherited ID, mentioned for the rest)
  const relation = workItemId === primaryWorkItemId ? "primary" : "mentioned";
  this.graph.linkThreadWorkItem(thread.id, workItemId, relation);

  const existing = this.graph.getWorkItemById(workItemId);
  if (existing) {
    const itemClassification = validatedBreakdownMap.get(workItemId);
    const itemStatus = itemClassification?.status ?? classification.status;
    const itemConfidence = itemClassification?.confidence ?? classification.confidence;
    const itemTitle = itemClassification?.title ?? classification.title;

    const shouldUpdate =
      !existing.currentConfidence ||
      itemConfidence >= existing.currentConfidence;

    if (shouldUpdate) {
      this.graph.upsertWorkItem({
        id: workItemId,
        source: existing.source,
        currentAtcStatus: itemStatus,
        currentConfidence: itemConfidence,
        ...(itemTitle && !existing.title ? { title: itemTitle } : {}),
      });
    }
  }
}
```

Key change: The `insertEvent` call that was inside the `if (itemClassification && itemClassification.status !== "noise")` block is removed entirely. Junction rows replace breakdown events.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "feat: pipeline writes junction rows instead of breakdown events"
```

---

### Task 6: Stream API — Junction-Based Queries

**Files:**
- Modify: `core/graph/index.ts:597-639` (getEventsForWorkItem, getEventsForWorkItemPaginated)
- Modify: `core/graph/index.ts:929-939` (getChannelsForWorkItem)
- Modify: `core/graph/index.ts:943-1094` (getFleetItems, getActionableItems, getAllActiveItems)
- Modify: `core/server.ts:168-248` (stream route)
- Modify: `core/stream.ts` (add relation to TimelineEntry)
- Modify: `src/lib/api.ts` (add relation to frontend type)
- Test: `tests/server/stream-api.test.ts`

- [ ] **Step 1: Write failing test for relation field in timeline**

Add to `tests/server/stream-api.test.ts`:

```typescript
it("timeline entries have a relation field", async () => {
  // Seed: work item, thread, junction row (primary), event
  // Seed: second thread with junction row (mentioned), event
  // Fetch stream for the work item
  // Assert: primary event has relation "primary", mentioned event has relation "mentioned"

  // Use existing test setup pattern. Key assertion:
  const res = await app.request(`/api/work-item/AI-100/stream`);
  const data = await res.json();
  expect(data.timeline[0]).toHaveProperty("relation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/stream-api.test.ts`
Expected: FAIL — no `relation` field on timeline entries

- [ ] **Step 3: Update getEventsForWorkItem queries to use junction table**

In `core/graph/index.ts`, update `getEventsForWorkItem` (line 597):

```typescript
getEventsForWorkItem(workItemId: string): Event[] {
  const rows = this.db.db
    .prepare(`
      SELECT e.* FROM events e
      WHERE e.work_item_id = ?
         OR e.thread_id IN (SELECT thread_id FROM thread_work_items WHERE work_item_id = ?)
      ORDER BY e.timestamp ASC, e.rowid ASC
    `)
    .all(workItemId, workItemId) as EventRow[];
  return rows.map(toEvent);
}
```

Update `getEventsForWorkItemPaginated` (line 612):

```typescript
getEventsForWorkItemPaginated(
  workItemId: string,
  limit: number = 10,
  before?: string,
): { events: Event[]; hasOlder: boolean } {
  let sql = `
    SELECT e.*,
      CASE WHEN e.work_item_id = ? THEN 'primary' ELSE 'mentioned' END AS _relation
    FROM events e
    WHERE e.work_item_id = ?
       OR e.thread_id IN (SELECT thread_id FROM thread_work_items WHERE work_item_id = ?)
  `;
  const params: any[] = [workItemId, workItemId, workItemId];

  if (before) {
    sql += " AND e.timestamp < ?";
    params.push(before);
  }

  sql += " ORDER BY e.timestamp DESC LIMIT ?";
  params.push(limit + 1);

  const rows = this.db.db.prepare(sql).all(...params) as Array<EventRow & { _relation: string }>;
  const hasOlder = rows.length > limit;
  const eventRows = hasOlder ? rows.slice(0, limit) : rows;

  const events = eventRows.map((row) => ({
    ...toEvent(row),
    relation: row._relation as "primary" | "mentioned",
  })).reverse();
  return { events, hasOlder };
}
```

- [ ] **Step 4: Update getChannelsForWorkItem to use junction table**

In `core/graph/index.ts`, update `getChannelsForWorkItem` (line 929):

```typescript
getChannelsForWorkItem(workItemId: string): Array<{ id: string; name: string }> {
  const rows = this.db.db
    .prepare(`
      SELECT DISTINCT t.channel_id AS id, t.channel_name AS name
      FROM threads t
      JOIN thread_work_items twi ON twi.thread_id = t.id
      WHERE twi.work_item_id = ?
      ORDER BY t.last_activity DESC
    `)
    .all(workItemId) as Array<{ id: string; name: string }>;
  return rows;
}
```

- [ ] **Step 5: Update getFleetItems/getActionableItems/getAllActiveItems/getRecentItems subqueries**

In each of these methods, replace the correlated subquery that finds the latest event:

Old pattern:
```sql
WHERE e2.work_item_id = wi.id
   OR t2.work_item_id = wi.id
```

New pattern:
```sql
WHERE e2.work_item_id = wi.id
   OR e2.thread_id IN (SELECT thread_id FROM thread_work_items WHERE work_item_id = wi.id)
```

Apply this change to:
- `getFleetItems` (line ~969-970)
- `getActionableItems` (line ~1020-1021)
- `getAllActiveItems` (line ~1069-1070)
- `getRecentItems` (line ~1266-1267)

- [ ] **Step 6: Add relation to TimelineEntry and buildTimeline**

In `core/stream.ts`, add `relation` to `TimelineEntry`:

```typescript
export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: StatusCategory;
  timestamp: string;
  agentId: string | null;
  agentName: string | null;
  agentAvatarUrl: string | null;
  channelId: string;
  channelName: string;
  threadId: string;
  platform: string;
  summary: string;
  rawText: string;
  isOperator: boolean;
  relation?: "primary" | "mentioned";
}
```

Update `buildTimeline` to pass through the relation field from events:

```typescript
export function buildTimeline(
  events: Array<Event & { relation?: "primary" | "mentioned" }>,
  agentMap: Map<string, string>,
  agentAvatarMap: Map<string, string | null>,
  threadChannelMap: Map<string, { channelId: string; channelName: string }>,
  threadPlatformMap: Map<string, string>,
): TimelineEntry[] {
  return events
    .filter((e) => e.entryType !== "noise")
    .map((e) => {
      const channel = threadChannelMap.get(e.threadId);
      return {
        id: e.id,
        entryType: e.entryType,
        status: e.status,
        timestamp: e.timestamp,
        agentId: e.agentId,
        agentName: e.agentId ? (agentMap.get(e.agentId) ?? null) : null,
        agentAvatarUrl: e.agentId ? (agentAvatarMap.get(e.agentId) ?? null) : null,
        channelId: channel?.channelId ?? "",
        channelName: channel?.channelName ?? "",
        threadId: e.threadId,
        platform: threadPlatformMap.get(e.threadId) ?? "",
        summary: e.reason,
        rawText: e.rawText,
        isOperator: e.agentId === null,
        relation: e.relation,
      };
    });
}
```

In `src/lib/api.ts`, add `relation` to the frontend `TimelineEntry`:

```typescript
export interface TimelineEntry {
  // ... existing fields ...
  relation?: "primary" | "mentioned";
}
```

- [ ] **Step 7: Update stream route in server.ts to use junction-based thread lookup**

In `core/server.ts` line 179, update:

```typescript
const threads = state.graph.getThreadsForWorkItemViaJunction(id);
```

(The `getThreadsForWorkItem` call using `threads.work_item_id` directly is replaced. Keep the rest of the route logic the same — it already handles thread metadata enrichment for events from unlinked threads.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/server/stream-api.test.ts`
Expected: PASS

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add core/graph/index.ts core/stream.ts core/server.ts src/lib/api.ts tests/server/stream-api.test.ts
git commit -m "feat: stream queries use junction table, timeline entries include relation"
```

---

### Task 7: Action Handler — Junction-Based Thread Lookup

**Files:**
- Modify: `core/server.ts:692-703` (findThreadForWorkItem)
- Test: `tests/server/actions-new.test.ts` or `tests/actions/actions.test.ts`

- [ ] **Step 1: Write failing test for junction-based thread lookup in actions**

Add to the actions test file:

```typescript
it("action handler finds thread via junction when no direct thread link exists", async () => {
  // Seed: work item AI-300 with no threads.work_item_id pointing to it
  // But: a junction row exists (T1 → AI-300, mentioned)
  // Action: unblock AI-300
  // Assert: succeeds (finds T1 via junction), no 500 error
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/actions-new.test.ts`
Expected: FAIL — findThreadForWorkItem doesn't use junction

- [ ] **Step 3: Replace findThreadForWorkItem with junction query**

In `core/server.ts`, replace the `findThreadForWorkItem` helper (line ~697):

```typescript
function findThreadForWorkItem(workItemId: string) {
  const threads = state.graph.getThreadsForWorkItemViaJunction(workItemId);
  if (threads.length > 0) return threads[0];
  // Final fallback: scan events (covers edge cases during migration)
  const events = state.graph.getEventsForWorkItem(workItemId);
  const withThread = [...events].reverse().find((e) => e.threadId);
  if (withThread) return state.graph.getThreadById(withThread.threadId) ?? undefined;
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/actions-new.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/server/actions-new.test.ts
git commit -m "feat: action handler uses junction table for thread lookup"
```

---

### Task 8: Timeline UI — Relation-Based Rendering

**Files:**
- Modify: `src/components/stream/Timeline.tsx`
- No separate test file (visual component — verify in browser)

- [ ] **Step 1: Replace FocusedMessage with relation-based rendering**

In `src/components/stream/Timeline.tsx`:

1. Remove the `FocusedMessage` component (lines 17-74)
2. Remove the `TICKET_ID_RE` regex (line 18)
3. Remove the `workItemId` prop from `TimelineProps` (line 13)
4. Update the raw text rendering section (lines 204-218) to use `relation`:

```tsx
{/* Raw text with platform-specific formatting */}
{entry.rawText && entry.rawText !== entry.summary && (
  <div className={`mt-1 text-xs leading-relaxed whitespace-pre-wrap ${
    entry.relation === "mentioned" ? "text-gray-600" : "text-gray-500"
  }`}>
    {entry.relation === "mentioned" ? (
      <details className="group">
        <summary className="cursor-pointer text-gray-600 hover:text-gray-400 list-none">
          <span className="text-[11px] italic">Mentioned in this thread</span>
          <span className="ml-1 text-[10px] text-gray-700 group-open:hidden">Show full message</span>
        </summary>
        <div className="mt-1">
          {entry.platform ? (
            <PlatformMessage platform={entry.platform} text={entry.rawText} userMap={userMap} />
          ) : (
            entry.rawText
          )}
        </div>
      </details>
    ) : entry.platform ? (
      <PlatformMessage platform={entry.platform} text={entry.rawText} userMap={userMap} />
    ) : (
      entry.rawText
    )}
  </div>
)}
```

- [ ] **Step 2: Remove workItemId prop from StreamDetail**

In `src/components/stream/StreamDetail.tsx`, remove `workItemId={workItemId}` from the `<Timeline>` component call (line ~238). The `Timeline` component no longer needs it.

- [ ] **Step 3: Verify in browser**

Run: `npm run dev`
Open the app, navigate to a work item that has both primary and mentioned timeline entries. Verify:
- Primary entries render as before (full message, full opacity)
- Mentioned entries show collapsed with "Mentioned in this thread" + expandable

- [ ] **Step 4: Commit**

```bash
git add src/components/stream/Timeline.tsx src/components/stream/StreamDetail.tsx
git commit -m "feat: timeline renders mentioned entries collapsed, remove FocusedMessage"
```

---

### Task 9: Cleanup — Remove Temporary Fixes

**Files:**
- Modify: `core/pipeline.ts` (remove validated breakdown filtering comment if now redundant)
- Verify: `core/server.ts` (findThreadForWorkItem now uses junction — event fallback can be removed later)

- [ ] **Step 1: Verify all tests pass**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Remove any dead code**

Check for:
- The `FocusedMessage` component is already removed in Task 8
- The `TICKET_ID_RE` regex is already removed in Task 8
- The breakdown event `insertEvent` block is already removed in Task 5
- The `findThreadForWorkItem` event-scanning fallback can remain as a safety net during transition

- [ ] **Step 3: Final full test run**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: cleanup dead code from junction table migration"
```
