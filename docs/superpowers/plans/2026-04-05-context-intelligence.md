# Context Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable thread-to-work-item inheritance, manual thread linking/unlinking, message forwarding, and new thread dispatch — all through the context pane hub.

**Architecture:** Four independently shippable components building on the pipeline and context pane. Component 1 is a pipeline-only fix. Components 2-4 add API endpoints and UI, with Components 3 and 4 sharing new `PlatformAdapter` interface methods.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Hono server, React, Vitest

---

### Task 1: Thread-to-Work-Item Inheritance (Pipeline Fix)

**Files:**
- Modify: `core/pipeline.ts:202-250`
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test — reply inherits thread's existing work item**

Add to `tests/core/pipeline.test.ts` inside the `processOnce` describe block:

```typescript
it("inherits work item ID from existing thread when message has no ticket", async () => {
  // Thread already linked to AI-382 in the graph
  vi.mocked(graph.getThreadById).mockReturnValue({
    id: "t-1",
    channelId: "C-1",
    channelName: "agent-orchestrator",
    platform: "slack",
    workItemId: "AI-382",
    lastActivity: "2026-03-30T09:00:00.000Z",
    messageCount: 1,
    messages: [],
  });

  // Message text has NO ticket reference
  const msg = makeMessage({ text: "Sounds good, I'll proceed with that approach" });
  const thread = makeThread({}, [msg]);
  vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

  // Linker finds nothing, classifier finds nothing
  vi.mocked(linker.linkMessage).mockReturnValue([]);
  vi.mocked(classifier.classify).mockResolvedValue(
    makeClassification({ status: "in_progress", workItemIds: [] }),
  );

  // Set up existing work item so status update path works
  const existingWi: WorkItem = {
    id: "AI-382",
    source: "extracted",
    title: "Auth refactor",
    externalStatus: null,
    assignee: null,
    url: null,
    currentAtcStatus: "in_progress",
    currentConfidence: 0.8,
    snoozedUntil: null,
    createdAt: "2026-03-29T10:00:00.000Z",
    updatedAt: "2026-03-29T10:00:00.000Z",
  };
  vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

  await pipeline.processOnce();

  // Event should be linked to the inherited work item
  expect(graph.insertEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      workItemId: "AI-382",
    }),
  );

  // Thread upsert should preserve AI-382 as the work item
  expect(graph.upsertThread).toHaveBeenCalledWith(
    expect.objectContaining({
      workItemId: "AI-382",
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "inherits work item"`
Expected: FAIL — event's `workItemId` will be a synthetic `thread:t-1` instead of `AI-382`

- [ ] **Step 3: Write the failing test — reply adds both inherited and new IDs**

Add to `tests/core/pipeline.test.ts` inside the `processOnce` describe block:

```typescript
it("merges inherited work item with newly extracted IDs", async () => {
  // Thread already linked to AI-382
  vi.mocked(graph.getThreadById).mockReturnValue({
    id: "t-1",
    channelId: "C-1",
    channelName: "agent-orchestrator",
    platform: "slack",
    workItemId: "AI-382",
    lastActivity: "2026-03-30T09:00:00.000Z",
    messageCount: 1,
    messages: [],
  });

  // Message mentions a DIFFERENT ticket
  const msg = makeMessage({ text: "Also related to IT-200" });
  const thread = makeThread({}, [msg]);
  vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

  vi.mocked(linker.linkMessage).mockReturnValue(["IT-200"]);
  vi.mocked(classifier.classify).mockResolvedValue(
    makeClassification({ status: "in_progress", workItemIds: [] }),
  );

  const existingAI382: WorkItem = {
    id: "AI-382", source: "extracted", title: "Auth refactor",
    externalStatus: null, assignee: null, url: null,
    currentAtcStatus: "in_progress", currentConfidence: 0.8,
    snoozedUntil: null, createdAt: "2026-03-29T10:00:00.000Z",
    updatedAt: "2026-03-29T10:00:00.000Z",
  };
  const existingIT200: WorkItem = { ...existingAI382, id: "IT-200", title: "Related work" };

  vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
    if (id === "AI-382") return existingAI382;
    if (id === "IT-200") return existingIT200;
    return null;
  });

  await pipeline.processOnce();

  // Both work items should get status updates
  const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
  const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus);
  const itUpdate = upsertCalls.find((c) => c[0].id === "IT-200" && c[0].currentAtcStatus);
  expect(aiUpdate).toBeDefined();
  expect(itUpdate).toBeDefined();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "merges inherited"`
Expected: FAIL — AI-382 won't be in the set

- [ ] **Step 5: Implement thread inheritance in pipeline**

In `core/pipeline.ts`, modify `processMessageInternal()`. Move `allWorkItemIds` initialization before Step 1 and add the inheritance check:

```typescript
private async processMessageInternal(message: Message, thread: Thread): Promise<Classification> {
    // Step 0: Skip if we've already processed this message (avoids duplicate LLM calls)
    if (this.graph.hasEvent(message.id, thread.id)) {
      log.debug("Skipping already-processed message", message.id);
      const existing = this.graph.getEventByMessageId(message.id, thread.id)!;
      return {
        status: existing.status as Classification["status"],
        confidence: existing.confidence,
        reason: existing.reason,
        workItemIds: existing.workItemId ? [existing.workItemId] : [],
        title: "",
      };
    }

    // Step 0b: Inherit work item from existing thread (if already linked)
    const existingThread = this.graph.getThreadById(thread.id);
    const inheritedWorkItemId = existingThread?.workItemId ?? null;
    const allWorkItemIds = new Set<string>();
    if (inheritedWorkItemId) {
      allWorkItemIds.add(inheritedWorkItemId);
    }

    // Step 1: Link work items from message text (regex — only known prefixes)
    const extractedIds = this.linker.linkMessage(message.text, thread.id);

    // Step 2: Classify the message
    const classification = await this.classifier.classify(message.text);

    // Separate LLM-suggested IDs into verified (match an extracted ID) and unverified
    const extractedSet = new Set(extractedIds);
    // Add extracted IDs to allWorkItemIds
    for (const id of extractedIds) {
      allWorkItemIds.add(id);
    }

    for (const llmId of classification.workItemIds) {
      if (!extractedSet.has(llmId)) {
        // LLM suggested an ID that the regex didn't find — treat as inferred
        this.graph.upsertWorkItem({
          id: llmId,
          source: "inferred",
          title: classification.title || llmId,
        });
      }
      allWorkItemIds.add(llmId);
    }

    // Step 2b: If no work item IDs found and this isn't noise, create a synthetic work item
    // keyed by thread ID so the conversation stays grouped under one item
    if (allWorkItemIds.size === 0 && classification.status !== "noise") {
      const syntheticId = `thread:${thread.id}`;
      this.graph.upsertWorkItem({
        id: syntheticId,
        source: "inferred",
        title: classification.title || "Untitled conversation",
        currentAtcStatus: classification.status,
        currentConfidence: classification.confidence,
      });
      allWorkItemIds.add(syntheticId);
      log.debug("Created synthetic work item for unticketed thread", syntheticId, classification.title);
    }
```

This replaces lines 216-251 of the current `processMessageInternal`. The rest of the method (Steps 3-7) stays unchanged.

- [ ] **Step 6: Run all pipeline tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (275+ tests)

- [ ] **Step 8: Commit**

```bash
git add core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "feat: inherit work item from thread when reply has no ticket ID

Replies in a linked thread now inherit the parent's work_item_id
instead of creating a synthetic thread: work item. The inherited ID
is added to allWorkItemIds before extraction and classification run,
so extracted or LLM-inferred IDs are merged with (not replacing) it.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Schema Migration — Add `manually_linked` Column

**Files:**
- Modify: `core/graph/db.ts:104-183` (migrate method)
- Modify: `core/graph/schema.ts`
- Modify: `core/types.ts`
- Modify: `core/graph/index.ts` (toThread mapper)

- [ ] **Step 1: Add `manually_linked` to `ThreadRow` in schema.ts**

In `core/graph/schema.ts`, add the field to `ThreadRow`:

```typescript
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
```

- [ ] **Step 2: Add `manuallyLinked` to `Thread` in types.ts**

In `core/types.ts`, add the field to `Thread`:

```typescript
export interface Thread {
  id: string;
  channelId: string;
  channelName: string;
  platformMeta?: Record<string, unknown>;
  platform: string;
  workItemId: string | null;
  lastActivity: string;
  messageCount: number;
  messages: Message[];
  manuallyLinked?: boolean;
}
```

- [ ] **Step 3: Update the `toThread` mapper in graph/index.ts**

In `core/graph/index.ts`, update the `toThread` function:

```typescript
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
```

- [ ] **Step 4: Add migration in db.ts**

In `core/graph/db.ts`, add to the end of the `migrate()` method:

```typescript
    // Add manually_linked column to threads table
    const threadColsForManual = this.db.pragma("table_info(threads)") as Array<{ name: string }>;
    if (!threadColsForManual.some((c) => c.name === "manually_linked")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN manually_linked INTEGER DEFAULT 0");
      log.info("Migration: added manually_linked column to threads");
    }
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/graph/db.ts core/graph/schema.ts core/types.ts core/graph/index.ts
git commit -m "schema: add manually_linked column to threads table

Tracks operator-initiated thread-to-work-item links. When set,
the pipeline preserves the link instead of overwriting it.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Graph Methods — linkThread, unlinkThread, getUnlinkedThreads

**Files:**
- Modify: `core/graph/index.ts`
- Create: `tests/graph/thread-linking.test.ts`

- [ ] **Step 1: Write failing tests for linkThread and unlinkThread**

Create `tests/graph/thread-linking.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("Thread Linking", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    // Seed a work item and two threads
    graph.upsertWorkItem({ id: "AI-100", source: "extracted", title: "Test work item" });
    graph.upsertThread({
      id: "t-1", channelId: "C-1", channelName: "general",
      platform: "slack", lastActivity: "2026-04-01T10:00:00.000Z",
    });
    graph.upsertThread({
      id: "t-2", channelId: "C-2", channelName: "dev",
      platform: "slack", lastActivity: "2026-04-02T10:00:00.000Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("linkThread", () => {
    it("sets work_item_id and manually_linked on the thread", () => {
      graph.linkThread("t-1", "AI-100");

      const thread = graph.getThreadById("t-1");
      expect(thread).not.toBeNull();
      expect(thread!.workItemId).toBe("AI-100");
      expect(thread!.manuallyLinked).toBe(true);
    });

    it("overwrites an existing auto-linked work item", () => {
      // Auto-link t-1 to a different work item
      graph.upsertWorkItem({ id: "AI-200", source: "extracted", title: "Other" });
      graph.upsertThread({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "AI-200",
      });

      // Manually link to AI-100
      graph.linkThread("t-1", "AI-100");

      const thread = graph.getThreadById("t-1");
      expect(thread!.workItemId).toBe("AI-100");
      expect(thread!.manuallyLinked).toBe(true);
    });
  });

  describe("unlinkThread", () => {
    it("clears work_item_id and resets manually_linked", () => {
      graph.linkThread("t-1", "AI-100");
      graph.unlinkThread("t-1");

      const thread = graph.getThreadById("t-1");
      expect(thread!.workItemId).toBeNull();
      expect(thread!.manuallyLinked).toBe(false);
    });
  });

  describe("getUnlinkedThreads", () => {
    it("returns threads with no work item", () => {
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked).toHaveLength(2);
    });

    it("excludes manually linked threads", () => {
      graph.linkThread("t-1", "AI-100");
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0].id).toBe("t-2");
    });

    it("includes threads with synthetic thread: work items", () => {
      graph.upsertWorkItem({ id: "thread:t-1", source: "inferred", title: "Untitled" });
      graph.upsertThread({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "thread:t-1",
      });

      const unlinked = graph.getUnlinkedThreads(20);
      // t-1 should still appear as "unlinked" since it only has a synthetic ID
      expect(unlinked.some((t) => t.id === "t-1")).toBe(true);
    });

    it("respects the limit parameter", () => {
      const unlinked = graph.getUnlinkedThreads(1);
      expect(unlinked).toHaveLength(1);
    });

    it("filters by channel name when query is provided", () => {
      const unlinked = graph.getUnlinkedThreads(20, "dev");
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0].channelName).toBe("dev");
    });

    it("returns results ordered by last_activity DESC", () => {
      const unlinked = graph.getUnlinkedThreads(20);
      expect(unlinked[0].id).toBe("t-2"); // more recent
      expect(unlinked[1].id).toBe("t-1");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/thread-linking.test.ts`
Expected: FAIL — `linkThread`, `unlinkThread`, `getUnlinkedThreads` don't exist

- [ ] **Step 3: Implement the three graph methods**

In `core/graph/index.ts`, add after the `getThreadsForWorkItem` method:

```typescript
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
```

- [ ] **Step 4: Run thread linking tests**

Run: `npx vitest run tests/graph/thread-linking.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/graph/index.ts tests/graph/thread-linking.test.ts
git commit -m "feat: add linkThread, unlinkThread, getUnlinkedThreads to ContextGraph

Supports manual thread-to-work-item association. linkThread sets
manually_linked=1, unlinkThread resets it to 0. getUnlinkedThreads
returns threads with no work item or only synthetic thread: IDs.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Pipeline — Respect `manually_linked` Flag

**Files:**
- Modify: `core/pipeline.ts:263-273` (Step 4 upsertThread)
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/pipeline.test.ts` inside the `processOnce` describe block:

```typescript
it("does not overwrite work_item_id on manually linked threads", async () => {
  // Thread is manually linked to AI-100
  vi.mocked(graph.getThreadById).mockReturnValue({
    id: "t-1",
    channelId: "C-1",
    channelName: "agent-orchestrator",
    platform: "slack",
    workItemId: "AI-100",
    lastActivity: "2026-03-30T09:00:00.000Z",
    messageCount: 1,
    messages: [],
    manuallyLinked: true,
  });

  // Message mentions a DIFFERENT ticket
  const msg = makeMessage({ text: "Working on IT-200 now" });
  const thread = makeThread({}, [msg]);
  vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

  vi.mocked(linker.linkMessage).mockReturnValue(["IT-200"]);
  vi.mocked(classifier.classify).mockResolvedValue(
    makeClassification({ status: "in_progress", workItemIds: [] }),
  );

  const existingAI100: WorkItem = {
    id: "AI-100", source: "extracted", title: "Manual work",
    externalStatus: null, assignee: null, url: null,
    currentAtcStatus: null, currentConfidence: null,
    snoozedUntil: null, createdAt: "2026-03-29T10:00:00.000Z",
    updatedAt: "2026-03-29T10:00:00.000Z",
  };
  const existingIT200: WorkItem = { ...existingAI100, id: "IT-200", title: "Other" };

  vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
    if (id === "AI-100") return existingAI100;
    if (id === "IT-200") return existingIT200;
    return null;
  });

  await pipeline.processOnce();

  // Thread upsert should keep AI-100 (the manually linked ID), NOT IT-200
  expect(graph.upsertThread).toHaveBeenCalledWith(
    expect.objectContaining({
      workItemId: "AI-100",
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts -t "manually linked"`
Expected: FAIL — pipeline will set workItemId to IT-200 or AI-100 based on set ordering, not intentionally preserving the manual link

- [ ] **Step 3: Implement manually_linked protection in pipeline**

In `core/pipeline.ts`, modify the Step 4 upsert thread block. Replace the existing thread upsert (around line 263):

```typescript
    // Step 4: Upsert thread in graph — preserve manually linked work items
    const isManuallyLinked = existingThread?.manuallyLinked === true;
    const primaryWorkItemId = allWorkItemIds.size > 0 ? [...allWorkItemIds][0] : null;

    this.graph.upsertThread({
      id: thread.id,
      channelId: thread.channelId,
      channelName: thread.channelName,
      platformMeta: thread.platformMeta,
      platform: thread.platform,
      workItemId: isManuallyLinked ? existingThread!.workItemId : primaryWorkItemId,
      lastActivity: message.timestamp,
      messageCount: thread.messages.length,
    });
```

Note: `existingThread` is already fetched in Task 1's inheritance check. The `isManuallyLinked` check uses the same variable.

- [ ] **Step 4: Run pipeline tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "feat: pipeline respects manually_linked flag on threads

When a thread has manually_linked=true, the pipeline preserves the
operator's chosen work_item_id instead of overwriting it with
extracted or inferred IDs from new messages.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Thread Management API Endpoints

**Files:**
- Modify: `core/server.ts`
- Modify: `src/lib/api.ts`
- Create: `tests/server/thread-linking-api.test.ts`

- [ ] **Step 1: Write failing tests for the 4 endpoints**

Create `tests/server/thread-linking-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// We test the endpoints by importing createApp and providing a mock state.
// Since createApp is tightly coupled, we test via HTTP against a running app.

describe("Thread Linking API", () => {
  // Inline mini-server to test endpoints in isolation
  let app: Hono;
  let mockGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockAdapter: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockGraph = {
      getWorkItemById: vi.fn().mockReturnValue({ id: "AI-100", source: "extracted", title: "Test" }),
      getThreadById: vi.fn().mockReturnValue({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: null, lastActivity: "2026-04-01T10:00:00.000Z",
        messageCount: 1, messages: [], manuallyLinked: false,
      }),
      linkThread: vi.fn(),
      unlinkThread: vi.fn(),
      getUnlinkedThreads: vi.fn().mockReturnValue([
        {
          id: "t-2", channelId: "C-2", channelName: "dev",
          platform: "slack", workItemId: null, lastActivity: "2026-04-02T10:00:00.000Z",
          messageCount: 5, messages: [], manuallyLinked: false,
        },
      ]),
      upsertThread: vi.fn().mockReturnValue({
        id: "t-new", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "AI-100", lastActivity: "2026-04-05T10:00:00.000Z",
        messageCount: 1, messages: [], manuallyLinked: true,
      }),
    };

    mockAdapter = {
      name: "slack",
      displayName: "Slack",
      getThreadMessages: vi.fn().mockResolvedValue([
        { id: "msg-1", threadId: "1711900000.000100", channelId: "C001",
          channelName: "general", userId: "U1", userName: "Byte",
          text: "Working on AI-100", timestamp: "2026-04-01T10:00:00.000Z", platform: "slack" },
      ]),
    };

    app = new Hono();

    // POST /api/work-item/:id/link-thread
    app.post("/api/work-item/:id/link-thread", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ threadId: string }>();
      if (!body.threadId) {
        return c.json({ error: "Missing threadId" }, 400);
      }
      mockGraph.linkThread(body.threadId, id);
      return c.json({ ok: true });
    });

    // POST /api/work-item/:id/unlink-thread
    app.post("/api/work-item/:id/unlink-thread", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ threadId: string }>();
      if (!body.threadId) {
        return c.json({ error: "Missing threadId" }, 400);
      }
      mockGraph.unlinkThread(body.threadId);
      return c.json({ ok: true });
    });

    // GET /api/threads/unlinked
    app.get("/api/threads/unlinked", (c) => {
      const limit = parseInt(c.req.query("limit") ?? "20", 10);
      const q = c.req.query("q") || undefined;
      const threads = mockGraph.getUnlinkedThreads(limit, q);
      return c.json({ threads });
    });

    // POST /api/work-item/:id/link-url
    app.post("/api/work-item/:id/link-url", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ url: string }>();
      if (!body.url) {
        return c.json({ error: "Missing url" }, 400);
      }

      // Parse Slack URL: https://team.slack.com/archives/C001/p1711900000000100
      const match = body.url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
      if (!match) {
        return c.json({ error: "Invalid Slack thread URL" }, 400);
      }
      const channelId = match[1];
      const rawTs = match[2];
      const threadTs = rawTs.slice(0, 10) + "." + rawTs.slice(10);

      // Fetch thread if not in graph
      if (!mockGraph.getThreadById(threadTs)) {
        const messages = await mockAdapter.getThreadMessages(threadTs, channelId);
        mockGraph.upsertThread({
          id: threadTs, channelId, channelName: "",
          platform: "slack", lastActivity: messages[0]?.timestamp ?? new Date().toISOString(),
          messageCount: messages.length,
        });
      }

      mockGraph.linkThread(threadTs, id);
      return c.json({ ok: true, threadId: threadTs });
    });
  });

  it("POST /api/work-item/:id/link-thread links a thread", async () => {
    const res = await app.request("/api/work-item/AI-100/link-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockGraph.linkThread).toHaveBeenCalledWith("t-1", "AI-100");
  });

  it("POST /api/work-item/:id/link-thread returns 404 for unknown work item", async () => {
    mockGraph.getWorkItemById.mockReturnValue(null);
    const res = await app.request("/api/work-item/NOPE/link-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/work-item/:id/unlink-thread unlinks a thread", async () => {
    const res = await app.request("/api/work-item/AI-100/unlink-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockGraph.unlinkThread).toHaveBeenCalledWith("t-1");
  });

  it("GET /api/threads/unlinked returns unlinked threads", async () => {
    const res = await app.request("/api/threads/unlinked?limit=10");
    expect(res.status).toBe(200);
    const data = await res.json() as { threads: unknown[] };
    expect(data.threads).toHaveLength(1);
  });

  it("GET /api/threads/unlinked passes query param", async () => {
    await app.request("/api/threads/unlinked?limit=10&q=dev");
    expect(mockGraph.getUnlinkedThreads).toHaveBeenCalledWith(10, "dev");
  });

  it("POST /api/work-item/:id/link-url parses Slack URL and links", async () => {
    mockGraph.getThreadById.mockReturnValue(null); // thread not in graph yet
    const res = await app.request("/api/work-item/AI-100/link-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://team.slack.com/archives/C001/p1711900000000100" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; threadId: string };
    expect(data.threadId).toBe("1711900000.000100");
    expect(mockGraph.linkThread).toHaveBeenCalledWith("1711900000.000100", "AI-100");
  });

  it("POST /api/work-item/:id/link-url rejects invalid URLs", async () => {
    const res = await app.request("/api/work-item/AI-100/link-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://google.com" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/thread-linking-api.test.ts`
Expected: PASS (these test against inline Hono routes, not the real server — they validate the endpoint logic pattern)

- [ ] **Step 3: Add the 4 endpoints to core/server.ts**

In `core/server.ts`, add after the existing `POST /api/reply` endpoint block:

```typescript
  // --- POST /api/work-item/:id/link-thread ---
  app.post("/api/work-item/:id/link-thread", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    const body = await c.req.json<{ threadId: string }>();
    if (!body.threadId) {
      return c.json({ error: "Missing threadId" }, 400);
    }
    state.graph.linkThread(body.threadId, id);
    return c.json({ ok: true });
  });

  // --- POST /api/work-item/:id/unlink-thread ---
  app.post("/api/work-item/:id/unlink-thread", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    const body = await c.req.json<{ threadId: string }>();
    if (!body.threadId) {
      return c.json({ error: "Missing threadId" }, 400);
    }
    state.graph.unlinkThread(body.threadId);
    return c.json({ ok: true });
  });

  // --- GET /api/threads/unlinked ---
  app.get("/api/threads/unlinked", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const q = c.req.query("q") || undefined;
    const threads = state.graph.getUnlinkedThreads(isNaN(limit) ? 20 : limit, q);
    return c.json({ threads });
  });

  // --- POST /api/work-item/:id/link-url ---
  app.post("/api/work-item/:id/link-url", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    if (!state.platformAdapter) {
      return c.json({ error: "No platform adapter configured" }, 503);
    }
    const body = await c.req.json<{ url: string }>();
    if (!body.url) {
      return c.json({ error: "Missing url" }, 400);
    }

    // Parse Slack thread URL: https://team.slack.com/archives/C001/p1711900000000100
    const match = body.url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
    if (!match) {
      return c.json({ error: "Invalid Slack thread URL" }, 400);
    }
    const channelId = match[1];
    const rawTs = match[2];
    const threadTs = rawTs.slice(0, 10) + "." + rawTs.slice(10);

    // Fetch thread if not already in graph
    if (!state.graph.getThreadById(threadTs)) {
      try {
        const messages = await state.platformAdapter.getThreadMessages(threadTs, channelId);
        state.graph.upsertThread({
          id: threadTs,
          channelId,
          channelName: "",
          platform: state.platformAdapter.name,
          lastActivity: messages[0]?.timestamp ?? new Date().toISOString(),
          messageCount: messages.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to fetch thread: ${message}` }, 500);
      }
    }

    state.graph.linkThread(threadTs, id);
    return c.json({ ok: true, threadId: threadTs });
  });
```

- [ ] **Step 4: Add typed API functions to src/lib/api.ts**

In `src/lib/api.ts`, add after the existing `fetchWorkItemContext` function:

```typescript
export function linkThread(
  workItemId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/link-thread`, {
    method: "POST",
    body: JSON.stringify({ threadId }),
  });
}

export function unlinkThread(
  workItemId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/unlink-thread`, {
    method: "POST",
    body: JSON.stringify({ threadId }),
  });
}

export function fetchUnlinkedThreads(
  limit = 20,
  query?: string,
): Promise<{ threads: Thread[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("q", query);
  return apiFetch(`/api/threads/unlinked?${params}`);
}

export function linkThreadByUrl(
  workItemId: string,
  url: string,
): Promise<{ ok: boolean; threadId: string }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/link-url`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}
```

Note: The `Thread` type already exists in `api.ts` — reuse it.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/server.ts src/lib/api.ts tests/server/thread-linking-api.test.ts
git commit -m "feat: add thread linking API endpoints

POST /api/work-item/:id/link-thread — manually link a thread
POST /api/work-item/:id/unlink-thread — unlink and reset manually_linked
GET /api/threads/unlinked — list recent unlinked threads with search
POST /api/work-item/:id/link-url — link by Slack thread URL

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Context Pane — Action Bar and Link Thread Panel

**Files:**
- Modify: `src/components/ContextPane.tsx`

- [ ] **Step 1: Add action bar and link panel state**

In `src/components/ContextPane.tsx`, add imports and state at the top of the component:

```typescript
import {
  fetchWorkItemContext,
  generateSummary,
  postReply,
  linkThread as apiLinkThread,
  unlinkThread as apiUnlinkThread,
  fetchUnlinkedThreads,
  linkThreadByUrl,
  type WorkItemContext,
  type Mentionable,
  type Thread,
} from "../lib/api";
```

Add state variables inside the component function, after the existing state:

```typescript
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [actionPanel, setActionPanel] = useState<"link" | "forward" | "new-thread" | null>(null);
  const [unlinkedThreads, setUnlinkedThreads] = useState<Thread[]>([]);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linking, setLinking] = useState(false);
```

- [ ] **Step 2: Add link panel fetch and handlers**

Add handler functions after the existing `handleReplySubmit`:

```typescript
  // Fetch unlinked threads when link panel opens
  useEffect(() => {
    if (actionPanel !== "link") return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchUnlinkedThreads(20, linkSearch || undefined);
        if (!cancelled) setUnlinkedThreads(res.threads);
      } catch {
        if (!cancelled) setUnlinkedThreads([]);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [actionPanel, linkSearch]);

  async function handleLinkThread(threadId: string) {
    setLinking(true);
    try {
      await apiLinkThread(workItemId, threadId);
      setActionPanel(null);
      // Refresh context
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setLinking(false);
    }
  }

  async function handleLinkUrl() {
    if (!linkUrl.trim()) return;
    setLinking(true);
    try {
      await linkThreadByUrl(workItemId, linkUrl.trim());
      setLinkUrl("");
      setActionPanel(null);
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlinkThread(threadId: string) {
    try {
      await apiUnlinkThread(workItemId, threadId);
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlink failed");
    }
  }
```

- [ ] **Step 3: Replace the Conversation section with threads list + action bar**

Replace the existing `{/* Conversation Thread */}` section in the JSX with:

```tsx
          {/* Conversations */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Conversations ({threads.length})
            </h3>
            <div className="space-y-1.5">
              {threads.map((t) => (
                <div
                  key={t.id}
                  onClick={() => setSelectedThreadId(selectedThreadId === t.id ? null : t.id)}
                  className={`rounded border px-3 py-2 text-sm cursor-pointer transition-colors ${
                    selectedThreadId === t.id
                      ? "border-blue-600 bg-blue-900/20"
                      : "border-gray-800 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-gray-300">{t.channelName || t.channelId}</span>
                      {t.manuallyLinked && (
                        <span className="ml-2 text-[10px] text-blue-400">manually linked</span>
                      )}
                    </div>
                    {t.manuallyLinked && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnlinkThread(t.id); }}
                        className="text-gray-600 hover:text-gray-400 text-xs cursor-pointer"
                        title="Unlink thread"
                      >
                        &#x2715;
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {t.messageCount} messages · {timeAgo(t.lastActivity)}
                  </div>
                </div>
              ))}
            </div>

            {/* Action bar */}
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
              <button
                onClick={() => setActionPanel(actionPanel === "link" ? null : "link")}
                className={`flex-1 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors ${
                  actionPanel === "link"
                    ? "border border-blue-600 text-blue-400 bg-blue-900/20"
                    : "border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                + Link thread
              </button>
              <button
                disabled={!selectedThreadId}
                onClick={() => setActionPanel(actionPanel === "forward" ? null : "forward")}
                className={`flex-1 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  actionPanel === "forward"
                    ? "border border-blue-600 text-blue-400 bg-blue-900/20"
                    : "border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                ↗ Forward
              </button>
              <button
                onClick={() => setActionPanel(actionPanel === "new-thread" ? null : "new-thread")}
                className="flex-1 py-1.5 rounded text-xs font-medium cursor-pointer border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600 transition-colors"
              >
                ⊕ New thread
              </button>
            </div>

            {/* Link thread panel */}
            {actionPanel === "link" && (
              <div className="mt-3 border border-blue-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="p-3 border-b border-gray-800">
                  <input
                    type="text"
                    placeholder="Search by channel name..."
                    value={linkSearch}
                    onChange={(e) => setLinkSearch(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {unlinkedThreads.length === 0 ? (
                    <div className="p-3 text-xs text-gray-500 text-center">No unlinked threads found</div>
                  ) : (
                    unlinkedThreads.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => handleLinkThread(t.id)}
                        disabled={linking}
                        className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors cursor-pointer disabled:opacity-50 border-b border-gray-800 last:border-b-0"
                      >
                        <div className="text-sm text-gray-300">{t.channelName || t.channelId}</div>
                        <div className="text-xs text-gray-500">{t.messageCount} messages · {timeAgo(t.lastActivity)}</div>
                      </button>
                    ))
                  )}
                </div>
                <div className="p-3 border-t border-gray-800">
                  <div className="text-xs text-gray-500 mb-1.5">Or paste a Slack thread URL</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="https://team.slack.com/archives/..."
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleLinkUrl()}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600"
                    />
                    <button
                      onClick={handleLinkUrl}
                      disabled={!linkUrl.trim() || linking}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Link
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Event history (moved from conversations section) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Event History ({events.length})
            </h3>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {[...events].reverse().map((evt) => {
                const isHighlighted = evt.status !== "noise" && evt.status !== "in_progress";
                return (
                  <div
                    key={evt.id}
                    className={`rounded bg-gray-900 px-3 py-2 text-sm ${
                      isHighlighted ? "border-l-2 border-amber-500" : "border-l-2 border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                      <span>{timeAgo(evt.timestamp)}</span>
                      <StatusBadge status={evt.status} />
                    </div>
                    <div className="text-gray-300 whitespace-pre-wrap break-words">
                      <MessageRenderer
                        platform={thread?.platform ?? "unknown"}
                        text={evt.rawText}
                        userMap={userMap}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ContextPane.tsx src/lib/api.ts
git commit -m "feat: context pane action bar with link/unlink thread UI

Add thread management hub to context pane:
- Thread list with selection, manually-linked badges, unlink button
- Action bar: Link thread / Forward / New thread buttons
- Link panel: searchable unlinked threads list + Slack URL input

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: PlatformAdapter Interface — postMessage and sendDirectMessage

**Files:**
- Modify: `core/adapters/platforms/interface.ts`
- Modify: `core/adapters/platforms/slack/index.ts`
- Test: `tests/adapters/slack.test.ts`

- [ ] **Step 1: Add methods to PlatformAdapter interface**

In `core/adapters/platforms/interface.ts`:

```typescript
export interface PlatformAdapter {
  name: string;
  displayName: string;
  connect(credentials: Credentials): Promise<void>;
  readThreads(since: Date, channels?: string[]): Promise<Thread[]>;
  replyToThread(threadId: string, channelId: string, message: string): Promise<void>;
  streamMessages(handler: (msg: Message) => void): void;
  getUsers(): Promise<Map<string, string>>; // userId -> displayName
  getThreadMessages(threadId: string, channelId: string): Promise<Message[]>;

  /** Post a new top-level message in a channel (not a reply) */
  postMessage(channelId: string, message: string): Promise<{ threadId: string }>;

  /** Open/get a DM channel with a user and post a message */
  sendDirectMessage(userId: string, message: string): Promise<{ channelId: string; threadId: string }>;
}
```

- [ ] **Step 2: Write failing tests for Slack adapter**

Add to `tests/adapters/slack.test.ts`, add a mock for `conversations.open`:

At the top where mocks are defined, add:

```typescript
const mockConversationsOpen = vi.fn();
```

In the `MockWebClient` class, add to conversations:

```typescript
conversations = {
  list: mockConversationsList,
  history: mockConversationsHistory,
  replies: mockConversationsReplies,
  open: mockConversationsOpen,
};
```

Add a new describe block:

```typescript
  describe("postMessage", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("posts a top-level message without thread_ts", async () => {
      mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1711900000.000100" });

      const result = await adapter.postMessage("C001", "Hello channel");

      expect(mockChatPostMessage).toHaveBeenCalledWith({
        channel: "C001",
        text: "Hello channel",
        as_user: true,
      });
      expect(result.threadId).toBe("1711900000.000100");
    });
  });

  describe("sendDirectMessage", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("opens a DM and posts a message", async () => {
      mockConversationsOpen.mockResolvedValue({
        ok: true,
        channel: { id: "D001" },
      });
      mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1711900100.000200" });

      const result = await adapter.sendDirectMessage("U123", "Hey there");

      expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U123" });
      expect(mockChatPostMessage).toHaveBeenCalledWith({
        channel: "D001",
        text: "Hey there",
        as_user: true,
      });
      expect(result.channelId).toBe("D001");
      expect(result.threadId).toBe("1711900100.000200");
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/slack.test.ts -t "postMessage"`
Expected: FAIL — method doesn't exist

- [ ] **Step 4: Implement postMessage and sendDirectMessage in Slack adapter**

In `core/adapters/platforms/slack/index.ts`, add after the `replyToThread` method:

```typescript
  async postMessage(channelId: string, message: string): Promise<{ threadId: string }> {
    this.ensureConnected();

    const result = await withRateLimitRetry(
      () =>
        this.client!.chat.postMessage({
          channel: channelId,
          text: message,
          as_user: true,
        }),
      "chat.postMessage",
      this.limiter,
    );

    const ts = (result as { ts?: string }).ts ?? "";
    log.info(`Posted message to channel ${channelId}, ts=${ts}`);
    return { threadId: ts };
  }

  async sendDirectMessage(userId: string, message: string): Promise<{ channelId: string; threadId: string }> {
    this.ensureConnected();

    const openResult = await withRateLimitRetry(
      () => this.client!.conversations.open({ users: userId }),
      "conversations.open",
      this.limiter,
    );

    const dmChannelId = (openResult as { channel?: { id?: string } }).channel?.id;
    if (!dmChannelId) {
      throw new Error(`Failed to open DM with user ${userId}`);
    }

    const postResult = await withRateLimitRetry(
      () =>
        this.client!.chat.postMessage({
          channel: dmChannelId,
          text: message,
          as_user: true,
        }),
      "chat.postMessage",
      this.limiter,
    );

    const ts = (postResult as { ts?: string }).ts ?? "";
    log.info(`Sent DM to ${userId} in channel ${dmChannelId}, ts=${ts}`);
    return { channelId: dmChannelId, threadId: ts };
  }
```

- [ ] **Step 5: Update mock platform adapter in pipeline tests**

In `tests/core/pipeline.test.ts`, add the two new methods to `createMockPlatformAdapter`:

```typescript
function createMockPlatformAdapter(): PlatformAdapter {
  return {
    name: "mock-slack",
    displayName: "Mock Slack",
    connect: vi.fn().mockResolvedValue(undefined),
    readThreads: vi.fn().mockResolvedValue([]),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    streamMessages: vi.fn(),
    getUsers: vi.fn().mockResolvedValue(new Map()),
    getThreadMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ threadId: "new-ts" }),
    sendDirectMessage: vi.fn().mockResolvedValue({ channelId: "D001", threadId: "new-ts" }),
  };
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add core/adapters/platforms/interface.ts core/adapters/platforms/slack/index.ts tests/adapters/slack.test.ts tests/core/pipeline.test.ts
git commit -m "feat: add postMessage and sendDirectMessage to PlatformAdapter

New interface methods for posting top-level messages and DMs.
Slack adapter implements via chat.postMessage + conversations.open.
Both use as_user: true and go through per-method rate limiting.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Forward Endpoint and Message Composition

**Files:**
- Modify: `core/server.ts`
- Modify: `src/lib/api.ts`
- Create: `tests/server/forward-api.test.ts`

- [ ] **Step 1: Write failing test for forward endpoint**

Create `tests/server/forward-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

describe("Forward API", () => {
  let app: Hono;
  let mockGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockAdapter: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockGraph = {
      getThreadById: vi.fn().mockReturnValue({
        id: "t-1", channelId: "C-1", channelName: "agent-orchestrator",
        platform: "slack", workItemId: "AI-100",
      }),
      getEventsForThread: vi.fn().mockReturnValue([
        { rawText: "Started working on auth", timestamp: "2026-04-01T10:00:00Z" },
        { rawText: "PR ready for review", timestamp: "2026-04-01T12:00:00Z" },
      ]),
      getSummary: vi.fn().mockReturnValue({
        summaryText: "• Auth middleware completed\n• PR #716 submitted",
      }),
      upsertThread: vi.fn().mockReturnValue({ id: "new-t" }),
      linkThread: vi.fn(),
    };

    mockAdapter = {
      postMessage: vi.fn().mockResolvedValue({ threadId: "new-ts" }),
      sendDirectMessage: vi.fn().mockResolvedValue({ channelId: "D001", threadId: "dm-ts" }),
      getThreadMessages: vi.fn().mockResolvedValue([
        { userName: "Byte", text: "Started working on auth" },
        { userName: "Pixel", text: "PR ready for review" },
      ]),
    };

    app = new Hono();

    app.post("/api/forward", async (c) => {
      const body = await c.req.json<{
        sourceThreadId: string;
        sourceChannelId: string;
        targetId: string;
        targetType: "user" | "channel";
        quoteMode?: "latest" | "full";
        includeSummary?: boolean;
        note?: string;
      }>();

      if (!body.sourceThreadId || !body.targetId || !body.targetType) {
        return c.json({ error: "Missing required fields" }, 400);
      }

      const sourceThread = mockGraph.getThreadById(body.sourceThreadId);
      if (!sourceThread) {
        return c.json({ error: "Source thread not found" }, 404);
      }

      // Build the forwarded message
      const parts: string[] = [];

      if (body.note) {
        parts.push(body.note);
      }

      const channelName = sourceThread.channelName || sourceThread.channelId;
      const quoteMode = body.quoteMode ?? "latest";

      if (quoteMode === "latest") {
        const events = mockGraph.getEventsForThread(body.sourceThreadId);
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          parts.push(`> Forwarded from #${channelName}:\n> "${lastEvent.rawText}"`);
        }
      } else {
        const messages = await mockAdapter.getThreadMessages(body.sourceThreadId, body.sourceChannelId);
        const quoted = messages
          .map((m: { userName: string; text: string }) => `> ${m.userName}: ${m.text}`)
          .join("\n");
        parts.push(`> Forwarded from #${channelName}:\n${quoted}`);
      }

      if (body.includeSummary) {
        const cached = mockGraph.getSummary(sourceThread.workItemId);
        if (cached) {
          parts.push(`Summary:\n${cached.summaryText}`);
        }
      }

      const composedMessage = parts.join("\n\n");

      let result: { threadId: string; channelId: string };
      if (body.targetType === "channel") {
        const r = await mockAdapter.postMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: body.targetId };
      } else {
        const r = await mockAdapter.sendDirectMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: r.channelId };
      }

      // Proactively link the new thread to the source work item
      if (sourceThread.workItemId) {
        mockGraph.upsertThread({
          id: result.threadId, channelId: result.channelId, channelName: "",
          platform: "slack", lastActivity: new Date().toISOString(), messageCount: 1,
        });
      }

      return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
    });
  });

  it("forwards latest message to a channel", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        quoteMode: "latest",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; threadId: string };
    expect(data.ok).toBe(true);

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("PR ready for review");
    expect(sentMessage).toContain("Forwarded from #agent-orchestrator");
  });

  it("forwards full thread to a user DM", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "U123",
        targetType: "user",
        quoteMode: "full",
      }),
    });
    expect(res.status).toBe(200);

    const sentMessage = mockAdapter.sendDirectMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("Byte: Started working on auth");
    expect(sentMessage).toContain("Pixel: PR ready for review");
  });

  it("includes summary when requested", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        includeSummary: true,
      }),
    });
    expect(res.status).toBe(200);

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("Auth middleware completed");
  });

  it("prepends operator note", async () => {
    await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        note: "FYI — needs your review",
      }),
    });

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage.startsWith("FYI — needs your review")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (inline Hono)**

Run: `npx vitest run tests/server/forward-api.test.ts`
Expected: PASS (tests the endpoint logic pattern)

- [ ] **Step 3: Add the forward endpoint to core/server.ts**

In `core/server.ts`, add after the link-url endpoint:

```typescript
  // --- POST /api/forward ---
  app.post("/api/forward", async (c) => {
    if (!state.platformAdapter) {
      return c.json({ ok: false, error: "No platform adapter configured" }, 503);
    }

    const body = await c.req.json<{
      sourceThreadId: string;
      sourceChannelId: string;
      targetId: string;
      targetType: "user" | "channel";
      quoteMode?: "latest" | "full";
      includeSummary?: boolean;
      note?: string;
    }>();

    if (!body.sourceThreadId || !body.targetId || !body.targetType) {
      return c.json({ ok: false, error: "Missing required fields: sourceThreadId, targetId, targetType" }, 400);
    }

    const sourceThread = state.graph.getThreadById(body.sourceThreadId);
    if (!sourceThread) {
      return c.json({ ok: false, error: "Source thread not found" }, 404);
    }

    // Build the forwarded message
    const parts: string[] = [];
    if (body.note) {
      parts.push(body.note);
    }

    const channelName = sourceThread.channelName || sourceThread.channelId;
    const quoteMode = body.quoteMode ?? "latest";

    try {
      if (quoteMode === "latest") {
        const events = state.graph.getEventsForThread(body.sourceThreadId);
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          parts.push(`> Forwarded from #${channelName}:\n> "${lastEvent.rawText}"`);
        }
      } else {
        const messages = await state.platformAdapter.getThreadMessages(
          body.sourceThreadId, body.sourceChannelId,
        );
        const quoted = messages
          .map((m) => `> ${m.userName}: ${m.text}`)
          .join("\n");
        parts.push(`> Forwarded from #${channelName}:\n${quoted}`);
      }

      if (body.includeSummary && sourceThread.workItemId) {
        const cached = state.graph.getSummary(sourceThread.workItemId);
        if (cached) {
          parts.push(`Summary:\n${cached.summaryText}`);
        }
      }

      const composedMessage = parts.join("\n\n");

      let result: { threadId: string; channelId: string };
      if (body.targetType === "channel") {
        const r = await state.platformAdapter.postMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: body.targetId };
      } else {
        const r = await state.platformAdapter.sendDirectMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: r.channelId };
      }

      // Proactively link new thread to source work item (as auto-linked)
      if (sourceThread.workItemId) {
        state.graph.upsertThread({
          id: result.threadId,
          channelId: result.channelId,
          channelName: "",
          platform: state.platformAdapter.name,
          workItemId: sourceThread.workItemId,
          lastActivity: new Date().toISOString(),
          messageCount: 1,
        });
      }

      return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Forward failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });
```

- [ ] **Step 4: Add typed API function to src/lib/api.ts**

```typescript
export function postForward(params: {
  sourceThreadId: string;
  sourceChannelId: string;
  targetId: string;
  targetType: "user" | "channel";
  quoteMode?: "latest" | "full";
  includeSummary?: boolean;
  note?: string;
}): Promise<{ ok: boolean; threadId: string; channelId: string }> {
  return apiFetch("/api/forward", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/server.ts src/lib/api.ts tests/server/forward-api.test.ts
git commit -m "feat: add POST /api/forward endpoint for message forwarding

Composes a forwarded message from source thread events, supports
latest/full quote modes and optional summary attachment. Posts via
platform adapter (postMessage or sendDirectMessage). Proactively
links the new thread to the source work item.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Extend Reply Endpoint for New Threads

**Files:**
- Modify: `core/server.ts` (POST /api/reply)
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Extend the reply endpoint**

In `core/server.ts`, replace the existing `POST /api/reply` handler:

```typescript
  // --- POST /api/reply ---
  app.post("/api/reply", async (c) => {
    if (!state.platformAdapter) {
      return c.json({ ok: false, error: "No platform adapter configured" }, 503);
    }

    const body = await c.req.json<{
      threadId?: string;
      channelId?: string;
      targetUserId?: string;
      message: string;
      workItemId?: string;
    }>();

    if (!body.message) {
      return c.json({ ok: false, error: "Missing required field: message" }, 400);
    }

    try {
      // Case 1: Reply to existing thread (original behavior)
      if (body.threadId && body.channelId) {
        await state.platformAdapter.replyToThread(body.threadId, body.channelId, body.message);
        return c.json({ ok: true });
      }

      // Case 2: New top-level message in a channel
      if (body.channelId && !body.threadId) {
        const result = await state.platformAdapter.postMessage(body.channelId, body.message);
        // Proactively link to work item if provided
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: body.channelId,
            channelName: "",
            platform: state.platformAdapter.name,
            workItemId: body.workItemId,
            lastActivity: new Date().toISOString(),
            messageCount: 1,
          });
        }
        return c.json({ ok: true, threadId: result.threadId, channelId: body.channelId });
      }

      // Case 3: DM to a user
      if (body.targetUserId) {
        const result = await state.platformAdapter.sendDirectMessage(body.targetUserId, body.message);
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: result.channelId,
            channelName: "",
            platform: state.platformAdapter.name,
            workItemId: body.workItemId,
            lastActivity: new Date().toISOString(),
            messageCount: 1,
          });
        }
        return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
      }

      return c.json({ ok: false, error: "Provide threadId+channelId, channelId alone, or targetUserId" }, 400);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Reply failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });
```

- [ ] **Step 2: Update postReply in src/lib/api.ts**

Replace the existing `postReply` function:

```typescript
export function postReply(
  threadId: string | undefined,
  channelId: string | undefined,
  message: string,
  options?: { targetUserId?: string; workItemId?: string },
): Promise<{ ok: boolean; threadId?: string; channelId?: string }> {
  return apiFetch("/api/reply", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      channelId,
      message,
      targetUserId: options?.targetUserId,
      workItemId: options?.workItemId,
    }),
  });
}
```

- [ ] **Step 3: Verify existing callers of postReply still compile**

Check that existing calls to `postReply(threadId, channelId, message)` still work — the new parameters are optional, so all existing callers are backwards-compatible.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts src/lib/api.ts
git commit -m "feat: extend POST /api/reply for new thread and DM creation

Reply endpoint now supports three modes:
- threadId + channelId: reply to existing thread (unchanged)
- channelId only: post new top-level message via adapter.postMessage
- targetUserId: send DM via adapter.sendDirectMessage
New threads are proactively linked to workItemId when provided.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Context Pane — Forward and New Thread Panels

**Files:**
- Modify: `src/components/ContextPane.tsx`

- [ ] **Step 1: Add forward and new-thread state and handlers**

Add state variables (after the existing link-related state from Task 6):

```typescript
  const [forwardTarget, setForwardTarget] = useState("");
  const [forwardTargetType, setForwardTargetType] = useState<"user" | "channel">("channel");
  const [forwardQuoteMode, setForwardQuoteMode] = useState<"latest" | "full">("latest");
  const [forwardIncludeSummary, setForwardIncludeSummary] = useState(false);
  const [forwardNote, setForwardNote] = useState("");
  const [forwarding, setForwarding] = useState(false);

  const [newThreadTarget, setNewThreadTarget] = useState("");
  const [newThreadTargetType, setNewThreadTargetType] = useState<"user" | "channel">("channel");
  const [newThreadMessage, setNewThreadMessage] = useState("");
  const [sendingNewThread, setSendingNewThread] = useState(false);
```

Add import for `postForward`:

```typescript
import {
  // ... existing imports ...
  postForward,
} from "../lib/api";
```

Add handlers:

```typescript
  async function handleForward() {
    if (!selectedThreadId || !forwardTarget.trim()) return;
    const selectedThread = threads.find((t) => t.id === selectedThreadId);
    if (!selectedThread) return;

    setForwarding(true);
    try {
      await postForward({
        sourceThreadId: selectedThreadId,
        sourceChannelId: selectedThread.channelId,
        targetId: forwardTarget.trim(),
        targetType: forwardTargetType,
        quoteMode: forwardQuoteMode,
        includeSummary: forwardIncludeSummary,
        note: forwardNote || undefined,
      });
      setActionPanel(null);
      setForwardTarget("");
      setForwardNote("");
      // Refresh context to show newly linked thread
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forward failed");
    } finally {
      setForwarding(false);
    }
  }

  async function handleNewThread() {
    if (!newThreadTarget.trim() || !newThreadMessage.trim()) return;
    setSendingNewThread(true);
    try {
      await postReply(
        undefined,
        newThreadTargetType === "channel" ? newThreadTarget.trim() : undefined,
        newThreadMessage.trim(),
        {
          targetUserId: newThreadTargetType === "user" ? newThreadTarget.trim() : undefined,
          workItemId,
        },
      );
      setActionPanel(null);
      setNewThreadTarget("");
      setNewThreadMessage("");
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingNewThread(false);
    }
  }
```

- [ ] **Step 2: Add forward panel JSX**

Add after the link panel's closing `)}` (inside the Conversations section), before `</section>`:

```tsx
            {/* Forward panel */}
            {actionPanel === "forward" && selectedThreadId && (
              <div className="mt-3 border border-blue-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                  <span className="text-xs font-semibold text-blue-400">
                    Forward from {threads.find((t) => t.id === selectedThreadId)?.channelName ?? "thread"}
                  </span>
                  <button onClick={() => setActionPanel(null)} className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm">&#x2715;</button>
                </div>
                <div className="p-3 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">To</label>
                    <div className="flex gap-2">
                      <select
                        value={forwardTargetType}
                        onChange={(e) => setForwardTargetType(e.target.value as "user" | "channel")}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                      >
                        <option value="channel">Channel</option>
                        <option value="user">User</option>
                      </select>
                      <input
                        type="text"
                        placeholder={forwardTargetType === "channel" ? "Channel ID (e.g. C001)" : "User ID (e.g. U001)"}
                        value={forwardTarget}
                        onChange={(e) => setForwardTarget(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Quote</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setForwardQuoteMode("latest")}
                        className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                          forwardQuoteMode === "latest" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 border border-gray-700"
                        }`}
                      >
                        Latest message
                      </button>
                      <button
                        onClick={() => setForwardQuoteMode("full")}
                        className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                          forwardQuoteMode === "full" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 border border-gray-700"
                        }`}
                      >
                        Full thread
                      </button>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={forwardIncludeSummary}
                      onChange={(e) => setForwardIncludeSummary(e.target.checked)}
                      disabled={!summary}
                      className="rounded"
                    />
                    Attach summary {!summary && <span className="text-gray-600">(no summary available)</span>}
                  </label>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Your note</label>
                    <input
                      type="text"
                      placeholder="Add context for the recipient..."
                      value={forwardNote}
                      onChange={(e) => setForwardNote(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setActionPanel(null)}
                      className="px-3 py-1.5 rounded text-xs border border-gray-700 text-gray-400 hover:text-gray-300 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleForward}
                      disabled={!forwardTarget.trim() || forwarding}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {forwarding ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* New thread panel */}
            {actionPanel === "new-thread" && (
              <div className="mt-3 border border-blue-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                  <span className="text-xs font-semibold text-blue-400">New thread</span>
                  <button onClick={() => setActionPanel(null)} className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm">&#x2715;</button>
                </div>
                <div className="p-3 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">To</label>
                    <div className="flex gap-2">
                      <select
                        value={newThreadTargetType}
                        onChange={(e) => setNewThreadTargetType(e.target.value as "user" | "channel")}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                      >
                        <option value="channel">Channel</option>
                        <option value="user">User</option>
                      </select>
                      <input
                        type="text"
                        placeholder={newThreadTargetType === "channel" ? "Channel ID (e.g. C001)" : "User ID (e.g. U001)"}
                        value={newThreadTarget}
                        onChange={(e) => setNewThreadTarget(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Message</label>
                    <textarea
                      placeholder="Write your message..."
                      value={newThreadMessage}
                      onChange={(e) => setNewThreadMessage(e.target.value)}
                      rows={3}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-600 resize-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setActionPanel(null)}
                      className="px-3 py-1.5 rounded text-xs border border-gray-700 text-gray-400 hover:text-gray-300 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleNewThread}
                      disabled={!newThreadTarget.trim() || !newThreadMessage.trim() || sendingNewThread}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {sendingNewThread ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            )}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/ContextPane.tsx src/lib/api.ts
git commit -m "feat: forward and new thread panels in context pane

Forward panel: target picker (channel/user), quote mode toggle
(latest/full), optional summary attachment, operator note field.
New thread panel: target picker and message input.
Both proactively link new threads to the current work item.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: Final Integration Test

**Files:**
- Tests only — verify end-to-end flow

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify Rust/Tauri compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Final commit with any fixups**

If any fixups were needed, commit them:

```bash
git add -A
git commit -m "fix: integration fixups for context intelligence

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
