# Stream Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Stream view as a live, work-item-level activity feed with persistent list+detail layout, filter tabs, auto-resolve, snooze with auto-break, send confirmation animations, and liveness signals.

**Architecture:** The Stream view becomes a two-panel layout (45/55 split) with filter tabs (Needs me / All active / Snoozed). Backend adds pin support, dismiss/noise actions, an all-active endpoint, snooze duration improvements, and timeline pagination. Frontend refactors the existing Inbox and WorkItemStream into new StreamView/StreamList/StreamDetail components with animations and liveness signals.

**Tech Stack:** React + TypeScript (frontend), Hono + SQLite (backend), Vitest (tests), Tailwind CSS (styling)

**Spec:** `docs/superpowers/specs/2026-04-21-stream-redesign-design.md`

---

## File Structure

### New files
- `src/components/StreamView.tsx` — Main Stream layout: two-panel container, filter tab state, polling
- `src/components/stream/StreamList.tsx` — Left panel: filtered work item list with animations
- `src/components/stream/StreamDetail.tsx` — Right panel: refactored from WorkItemStream, persistent (not overlay)
- `src/components/stream/FilterTabs.tsx` — Needs me / All active / Snoozed tab bar with badge counts
- `src/components/stream/SnoozeDropdown.tsx` — Time picker dropdown for snooze action
- `src/components/stream/StreamListItem.tsx` — Single list item with status badge, action state, animations
- `src/components/stream/SendConfirmation.tsx` — Inline Slack delivery confirmation in timeline
- `tests/server/all-active-api.test.ts` — Tests for /api/stream/all-active endpoint
- `tests/graph/pin.test.ts` — Tests for pin/unpin graph methods
- `tests/server/actions-new.test.ts` — Tests for dismiss, noise actions and delivered field

### Modified files
- `core/graph/db.ts` — Migration: add `pinned` and `dismissed_at` columns to work_items
- `core/graph/schema.ts` — Add pinned, dismissedAt to WorkItemRow
- `core/graph/index.ts` — Add togglePin, getAllActiveItems, getEventsPaginated; modify getActionableItems to exclude dismissed
- `core/types.ts` — Add pin field to WorkItem
- `core/server.ts` — New endpoints: /api/stream/all-active, /api/work-item/:id/pin; modify /api/action for dismiss, noise, delivered field, real snooze durations; modify /api/work-item/:id/stream for timeline pagination
- `core/stream.ts` — Modify buildTimeline to support oldest-first ordering
- `src/lib/api.ts` — New types, functions: fetchAllActive, togglePin, updated postAction return type
- `src/components/App.tsx` — Replace Inbox with StreamView, update tab rendering
- `src/components/stream/SuggestedActions.tsx` — Add Noise button, SnoozeDropdown, pin toggle
- `src/components/stream/Timeline.tsx` — Chat-style ordering, auto-scroll, load-older
- `src/components/stream/StatusSnapshot.tsx` — Add pin toggle to header
- `src/components/StatusBadge.tsx` — Add action states (Replied, Unblocked, Snoozed)
- `src/index.css` — New animations: list-item-enter, list-item-exit, badge-transition, input-success, input-error

### Removed files (after migration)
- `src/components/Inbox.tsx` — Replaced by StreamView.tsx
- `src/components/WorkItemStream.tsx` — Replaced by StreamDetail.tsx (logic moved, not deleted until wired)

---

## Task 1: Backend — Pin support and dismissed_at column

**Files:**
- Modify: `core/graph/db.ts`
- Modify: `core/graph/schema.ts`
- Modify: `core/graph/index.ts`
- Modify: `core/types.ts`
- Modify: `core/server.ts`
- Test: `tests/graph/pin.test.ts`

### Context

Work items need a `pinned` boolean (persisted across sessions) and a `dismissed_at` timestamp (so "Needs me" excludes dismissed items until a new blocking event re-triggers targeting). Both are columns on the `work_items` table.

Read these files before starting:
- `core/graph/db.ts` — see existing migration pattern (lines 230-260 for recent ALTER TABLE examples)
- `core/graph/schema.ts` — see WorkItemRow type (line ~35)
- `core/graph/index.ts` — see `upsertWorkItem` (line ~165), `getActionableItems` (line ~340), `toWorkItem` helper
- `core/types.ts` — see WorkItem interface (line ~70)
- `core/server.ts` — see POST /api/action handler (line ~585)

- [ ] **Step 1: Write the failing tests for pin and dismiss**

Create `tests/graph/pin.test.ts`:

```typescript
import Database from "better-sqlite3";
import { ContextGraph } from "../../core/graph/index.js";

describe("pin and dismiss", () => {
  let db: Database.Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    // Seed a work item
    graph.upsertWorkItem({
      id: "AI-100",
      source: "jira",
      title: "Test item",
      currentAtcStatus: "blocked_on_human",
    });
    // Seed a thread and event so getActionableItems can find it
    graph.upsertThread({
      id: "T001",
      channelId: "C001",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-100",
    });
    graph.insertEvent({
      threadId: "T001",
      messageId: "msg-1",
      workItemId: "AI-100",
      agentId: "agent-1",
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "blocked",
      rawText: "I need help",
      timestamp: new Date().toISOString(),
      entryType: "block",
      targetedAtOperator: true,
    });
    graph.upsertAgent({
      id: "agent-1",
      name: "ByteAgent",
      platform: "slack",
      platformUserId: "U001",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("togglePin", () => {
    it("pins an unpinned work item", () => {
      const result = graph.togglePin("AI-100");
      expect(result).toBe(true);
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.pinned).toBe(true);
    });

    it("unpins a pinned work item", () => {
      graph.togglePin("AI-100");
      const result = graph.togglePin("AI-100");
      expect(result).toBe(false);
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.pinned).toBe(false);
    });

    it("returns false for non-existent work item", () => {
      const result = graph.togglePin("NONEXISTENT");
      expect(result).toBe(false);
    });
  });

  describe("dismissWorkItem", () => {
    it("sets dismissed_at timestamp", () => {
      graph.dismissWorkItem("AI-100");
      const wi = graph.getWorkItemById("AI-100");
      expect(wi?.dismissedAt).not.toBeNull();
    });

    it("excludes dismissed items from getActionableItems", () => {
      const before = graph.getActionableItems();
      expect(before.length).toBe(1);

      graph.dismissWorkItem("AI-100");

      const after = graph.getActionableItems();
      expect(after.length).toBe(0);
    });

    it("re-includes item when new blocking event arrives after dismiss", () => {
      graph.dismissWorkItem("AI-100");
      expect(graph.getActionableItems().length).toBe(0);

      // New blocking event with timestamp after dismissed_at
      graph.insertEvent({
        threadId: "T001",
        messageId: "msg-2",
        workItemId: "AI-100",
        agentId: "agent-1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "blocked again",
        rawText: "Still need help",
        timestamp: new Date(Date.now() + 1000).toISOString(),
        entryType: "block",
        targetedAtOperator: true,
      });

      const after = graph.getActionableItems();
      expect(after.length).toBe(1);
    });
  });

  describe("pinned items in getActionableItems", () => {
    it("returns pinned field on actionable items", () => {
      graph.togglePin("AI-100");
      const items = graph.getActionableItems();
      expect(items[0].workItem.pinned).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/pin.test.ts`
Expected: FAIL — `togglePin` is not a function, `pinned` property doesn't exist

- [ ] **Step 3: Add migration for pinned and dismissed_at columns**

In `core/graph/db.ts`, add a new migration in the `migrate()` method after the last existing migration (around line 255). Follow the existing pattern of `try { ALTER TABLE } catch { already exists }`:

```typescript
// Migration: add pinned and dismissed_at to work_items
try {
  db.exec("ALTER TABLE work_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
} catch { /* column already exists */ }
try {
  db.exec("ALTER TABLE work_items ADD COLUMN dismissed_at TEXT DEFAULT NULL");
} catch { /* column already exists */ }
```

- [ ] **Step 4: Update WorkItemRow schema**

In `core/graph/schema.ts`, add to the `WorkItemRow` interface:

```typescript
pinned: number;         // 0 or 1
dismissed_at: string | null;
```

- [ ] **Step 5: Update WorkItem type**

In `core/types.ts`, add to the `WorkItem` interface:

```typescript
pinned: boolean;
dismissedAt: string | null;
```

- [ ] **Step 6: Implement graph methods**

In `core/graph/index.ts`:

1. Update the `toWorkItem` helper to map the new columns:
```typescript
pinned: Boolean(row.pinned),
dismissedAt: row.dismissed_at,
```

2. Add `togglePin` method to `ContextGraph`:
```typescript
togglePin(workItemId: string): boolean {
  const row = this.db.prepare("SELECT pinned FROM work_items WHERE id = ?").get(workItemId) as { pinned: number } | undefined;
  if (!row) return false;
  const newValue = row.pinned ? 0 : 1;
  this.db.prepare("UPDATE work_items SET pinned = ? WHERE id = ?").run(newValue, workItemId);
  return Boolean(newValue);
}
```

3. Add `dismissWorkItem` method:
```typescript
dismissWorkItem(workItemId: string): void {
  this.db.prepare("UPDATE work_items SET dismissed_at = ? WHERE id = ?").run(new Date().toISOString(), workItemId);
}
```

4. Modify `getActionableItems` SQL query — add a condition that either `dismissed_at IS NULL` or the latest event's timestamp is after `dismissed_at`. In the WHERE clause, add:
```sql
AND (wi.dismissed_at IS NULL OR e.timestamp > wi.dismissed_at)
```

5. Ensure `upsertWorkItem` maps `pinned` in the INSERT/UPDATE if provided, defaulting to 0.

- [ ] **Step 7: Add pin endpoint to server**

In `core/server.ts`, add a new endpoint after the existing work-item routes:

```typescript
app.post("/api/work-item/:id/pin", async (c) => {
  const { id } = c.req.param();
  const pinned = state.graph.togglePin(id);
  return c.json({ ok: true, pinned });
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/graph/pin.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass (the new columns have defaults so no breaking changes)

- [ ] **Step 10: Commit**

```bash
git add core/graph/db.ts core/graph/schema.ts core/graph/index.ts core/types.ts core/server.ts tests/graph/pin.test.ts
git commit -m "feat: add pin and dismiss support for work items"
```

---

## Task 2: Backend — Dismiss, noise actions and delivered field

**Files:**
- Modify: `core/server.ts`
- Test: `tests/server/actions-new.test.ts`

### Context

The POST /api/action endpoint currently handles "approve", "redirect", "close", "snooze". We need to add:
- `dismiss` — calls `graph.dismissWorkItem()`, inserts an event, does NOT change work item status
- `noise` — reclassifies work item status to "noise"
- All actions return `{ ok: true, delivered: boolean }` — `delivered` is true when a message was successfully sent to Slack

Read these files before starting:
- `core/server.ts` — POST /api/action handler (line ~585), understand the existing action flow
- `tests/server/stream-api.test.ts` — see the `makeState()` helper pattern for server tests
- `tests/actions/actions.test.ts` — see how actions are tested with mock adapters

- [ ] **Step 1: Write the failing tests**

Create `tests/server/actions-new.test.ts`:

```typescript
import Database from "better-sqlite3";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database.Database) {
  const messagingAdapter = {
    name: "mock",
    connect: vi.fn(),
    disconnect: vi.fn(),
    getChannels: vi.fn().mockResolvedValue([]),
    getThreadMessages: vi.fn().mockResolvedValue([]),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    getAuthenticatedUser: vi.fn().mockResolvedValue({ userId: "U_OP", userName: "Operator" }),
    fetchUsers: vi.fn().mockResolvedValue(new Map()),
    buildThread: vi.fn(),
    forwardMessage: vi.fn(),
  };

  return {
    config: {
      classifier: { provider: { baseUrl: "", model: "", apiKey: "" } },
      lookback: { initialDays: 3, maxThreadsPerPoll: 100 },
      rateLimits: {},
      operator: { name: "Test", role: "", context: "" },
    },
    db,
    graph,
    classifier: { classify: vi.fn() },
    pipeline: null,
    messagingAdapter,
    taskAdapter: null,
    messagingRegistry: { getAdapter: () => messagingAdapter },
    taskAdapterRegistry: { getAdapter: () => null },
    operatorIdentities: new Map(),
    startedAt: new Date(),
    services: {},
  } as any;
}

describe("dismiss and noise actions", () => {
  let db: Database.Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertWorkItem({
      id: "AI-200",
      source: "jira",
      title: "Test item",
      currentAtcStatus: "blocked_on_human",
    });
    graph.upsertThread({
      id: "T001",
      channelId: "C001",
      channelName: "general",
      platform: "slack",
      workItemId: "AI-200",
    });
    graph.insertEvent({
      threadId: "T001",
      messageId: "msg-1",
      workItemId: "AI-200",
      agentId: "agent-1",
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "blocked",
      rawText: "Need help",
      timestamp: new Date().toISOString(),
      entryType: "block",
      targetedAtOperator: true,
    });
    graph.upsertAgent({
      id: "agent-1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U001",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("dismiss action sets dismissed_at without changing status", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "dismiss" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("AI-200");
    expect(wi?.dismissedAt).not.toBeNull();
    expect(wi?.currentAtcStatus).toBe("blocked_on_human"); // status unchanged
  });

  it("noise action reclassifies work item as noise", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "noise" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const wi = graph.getWorkItemById("AI-200");
    expect(wi?.currentAtcStatus).toBe("noise");
  });

  it("action with message returns delivered: true on success", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workItemId: "AI-200",
        action: "redirect",
        message: "Done, try again",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(true);
  });

  it("action without message returns delivered: false", async () => {
    const state = makeState(graph, db);
    const app = createApp(state);

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "AI-200", action: "redirect" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delivered).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/actions-new.test.ts`
Expected: FAIL — dismiss and noise actions not recognized, delivered field not returned

- [ ] **Step 3: Add dismiss and noise actions to server**

In `core/server.ts`, find the POST /api/action handler. In the switch/case or if-chain that handles action types, add two new cases:

For `dismiss`:
```typescript
case "dismiss": {
  state.graph.dismissWorkItem(body.workItemId);
  // Insert an event recording the operator dismissal
  const threads = state.graph.getThreadsForWorkItem(body.workItemId);
  state.graph.insertEvent({
    threadId: threads[0]?.id ?? null,
    messageId: `operator-dismiss-${Date.now()}`,
    workItemId: body.workItemId,
    agentId: null,
    status: workItem.currentAtcStatus ?? "in_progress",
    confidence: 1.0,
    reason: "Operator dismissed from stream",
    rawText: body.message ?? null,
    timestamp: new Date().toISOString(),
    entryType: "decision",
    targetedAtOperator: false,
  });
  break;
}
```

For `noise`:
```typescript
case "noise": {
  state.graph.upsertWorkItem({
    id: body.workItemId,
    currentAtcStatus: "noise",
  });
  const threads = state.graph.getThreadsForWorkItem(body.workItemId);
  state.graph.insertEvent({
    threadId: threads[0]?.id ?? null,
    messageId: `operator-noise-${Date.now()}`,
    workItemId: body.workItemId,
    agentId: null,
    status: "noise",
    confidence: 1.0,
    reason: "Operator classified as noise",
    rawText: body.message ?? null,
    timestamp: new Date().toISOString(),
    entryType: "decision",
    targetedAtOperator: false,
  });
  break;
}
```

- [ ] **Step 4: Add delivered field to action response**

In the same handler, track whether a message was sent. Wrap the message-sending logic in a try/catch and set `let delivered = false`. Set `delivered = true` after successful send. Change the response from `c.json({ ok: true })` to `c.json({ ok: true, delivered })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/actions-new.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add core/server.ts tests/server/actions-new.test.ts
git commit -m "feat: add dismiss, noise actions and delivered field to action response"
```

---

## Task 3: Backend — All-active endpoint and snooze improvements

**Files:**
- Modify: `core/graph/index.ts`
- Modify: `core/server.ts`
- Test: `tests/server/all-active-api.test.ts`

### Context

We need a new `GET /api/stream/all-active` endpoint that returns all non-completed, non-noise work items (no `targetedAtOperator` filter). Also need to improve snooze: the frontend will send real durations in seconds, and snooze auto-breaks when new activity arrives (handled by the existing `snoozed_until` check + new event timestamp comparison).

Read these files before starting:
- `core/graph/index.ts` — see `getActionableItems` (line ~340) and `getFleetItems` for query patterns
- `core/server.ts` — see GET /api/fleet (line ~259) for endpoint pattern, POST /api/action snooze handling

- [ ] **Step 1: Write failing tests**

Create `tests/server/all-active-api.test.ts`:

```typescript
import Database from "better-sqlite3";
import { ContextGraph } from "../../core/graph/index.js";
import { createApp } from "../../core/server.js";

function makeState(graph: ContextGraph, db: Database.Database) {
  return {
    config: {
      classifier: { provider: { baseUrl: "", model: "", apiKey: "" } },
      lookback: { initialDays: 3, maxThreadsPerPoll: 100 },
      rateLimits: {},
      operator: { name: "Test", role: "", context: "" },
    },
    db,
    graph,
    classifier: { classify: vi.fn() },
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    messagingRegistry: { getAdapter: () => null },
    taskAdapterRegistry: { getAdapter: () => null },
    operatorIdentities: new Map(),
    startedAt: new Date(),
    services: {},
  } as any;
}

describe("GET /api/stream/all-active", () => {
  let db: Database.Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedItem(id: string, status: string, targeted: boolean) {
    graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: status as any });
    graph.upsertThread({ id: `T-${id}`, channelId: "C001", channelName: "general", platform: "slack", workItemId: id });
    graph.insertEvent({
      threadId: `T-${id}`, messageId: `msg-${id}`, workItemId: id,
      agentId: "agent-1", status: status as any, confidence: 0.9,
      reason: "test", rawText: "test", timestamp: new Date().toISOString(),
      entryType: "progress", targetedAtOperator: targeted,
    });
    graph.upsertAgent({ id: "agent-1", name: "Byte", platform: "slack", platformUserId: "U001" });
  }

  it("returns all non-completed, non-noise items regardless of targetedAtOperator", async () => {
    seedItem("AI-1", "blocked_on_human", true);
    seedItem("AI-2", "in_progress", false);
    seedItem("AI-3", "completed", false);
    seedItem("AI-4", "noise", false);
    seedItem("AI-5", "needs_decision", true);

    const state = makeState(graph, db);
    const app = createApp(state);
    const res = await app.request("/api/stream/all-active");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3); // AI-1, AI-2, AI-5 (not completed, not noise)
    const ids = body.items.map((i: any) => i.workItem.id);
    expect(ids).toContain("AI-1");
    expect(ids).toContain("AI-2");
    expect(ids).toContain("AI-5");
    expect(ids).not.toContain("AI-3");
    expect(ids).not.toContain("AI-4");
  });

  it("includes pinned field on items", async () => {
    seedItem("AI-1", "in_progress", false);
    graph.togglePin("AI-1");

    const state = makeState(graph, db);
    const app = createApp(state);
    const res = await app.request("/api/stream/all-active");

    const body = await res.json();
    expect(body.items[0].workItem.pinned).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/all-active-api.test.ts`
Expected: FAIL — endpoint not found (404)

- [ ] **Step 3: Add getAllActiveItems to graph**

In `core/graph/index.ts`, add a new method `getAllActiveItems()` that returns `ActionableItem[]`. Copy the structure of `getActionableItems()` but change the WHERE clause to:
```sql
WHERE wi.current_atc_status IS NOT NULL
  AND wi.current_atc_status NOT IN ('completed', 'noise')
```

Remove the `targeted_at_operator`, `snoozed_until`, and `dismissed_at` filters. Keep the same JOIN pattern for latest event, agent, and thread.

- [ ] **Step 4: Add the endpoint to server**

In `core/server.ts`, add before the fleet endpoint:

```typescript
app.get("/api/stream/all-active", async (c) => {
  const items = state.graph.getAllActiveItems();
  return c.json({ items });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/all-active-api.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add core/graph/index.ts core/server.ts tests/server/all-active-api.test.ts
git commit -m "feat: add all-active endpoint for Stream's broader work item view"
```

---

## Task 4: Backend — Timeline pagination

**Files:**
- Modify: `core/graph/index.ts`
- Modify: `core/server.ts`
- Modify: `core/stream.ts`
- Modify: existing `tests/server/stream-api.test.ts`

### Context

The timeline in the detail panel should support pagination: load latest N events, then load older on scroll. The `/api/work-item/:id/stream` endpoint needs to accept a `before` timestamp query param and return `hasOlder: boolean`.

Also, `buildTimeline` currently sorts newest-first. Change it to oldest-first (chat-style) so the frontend receives messages in chronological order.

Read these files before starting:
- `core/graph/index.ts` — see `getEventsForWorkItem` method
- `core/server.ts` — see GET /api/work-item/:id/stream (line ~166)
- `core/stream.ts` — see `buildTimeline` (line ~70)
- `tests/server/stream-api.test.ts` — existing timeline tests

- [ ] **Step 1: Write failing test for pagination**

Add to `tests/server/stream-api.test.ts`:

```typescript
describe("timeline pagination", () => {
  it("returns hasOlder: true when more events exist before the page", async () => {
    // Seed a work item with 15 events
    graph.upsertWorkItem({ id: "AI-300", source: "jira", title: "Pagination test", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "T-300", channelId: "C001", channelName: "test", platform: "slack", workItemId: "AI-300" });
    graph.upsertAgent({ id: "agent-1", name: "Byte", platform: "slack", platformUserId: "U001" });

    for (let i = 0; i < 15; i++) {
      graph.insertEvent({
        threadId: "T-300", messageId: `msg-${i}`, workItemId: "AI-300",
        agentId: "agent-1", status: "in_progress", confidence: 0.9,
        reason: `Event ${i}`, rawText: `Message ${i}`,
        timestamp: new Date(Date.now() - (15 - i) * 60000).toISOString(),
        entryType: "progress", targetedAtOperator: false,
      });
    }

    const state = makeState(graph, db);
    const app = createApp(state);

    // First page (no before param) — should get latest 10
    const res1 = await app.request("/api/work-item/AI-300/stream?limit=10");
    const body1 = await res1.json();
    expect(body1.timeline.length).toBe(10);
    expect(body1.hasOlder).toBe(true);
    // Should be in oldest-first order (chat style)
    expect(body1.timeline[0].summary).toContain("Event ");

    // Second page — use oldest event's timestamp as "before"
    const oldestTimestamp = body1.timeline[0].timestamp;
    const res2 = await app.request(`/api/work-item/AI-300/stream?limit=10&before=${encodeURIComponent(oldestTimestamp)}`);
    const body2 = await res2.json();
    expect(body2.timeline.length).toBe(5);
    expect(body2.hasOlder).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/stream-api.test.ts`
Expected: FAIL — hasOlder not in response, timeline not paginated

- [ ] **Step 3: Add paginated event query to graph**

In `core/graph/index.ts`, add a method `getEventsForWorkItemPaginated`:

```typescript
getEventsForWorkItemPaginated(
  workItemId: string,
  limit: number = 10,
  before?: string,
): { events: Event[]; hasOlder: boolean } {
  let sql = `
    SELECT e.* FROM events e
    LEFT JOIN threads t ON e.thread_id = t.id
    WHERE e.work_item_id = ? OR t.work_item_id = ?
  `;
  const params: any[] = [workItemId, workItemId];

  if (before) {
    sql += " AND e.timestamp < ?";
    params.push(before);
  }

  sql += " ORDER BY e.timestamp DESC LIMIT ?";
  params.push(limit + 1); // fetch one extra to check hasOlder

  const rows = this.db.prepare(sql).all(...params) as EventRow[];
  const hasOlder = rows.length > limit;
  const eventRows = hasOlder ? rows.slice(0, limit) : rows;

  // Reverse to oldest-first for chat-style display
  const events = eventRows.map(toEvent).reverse();
  return { events, hasOlder };
}
```

- [ ] **Step 4: Update buildTimeline to accept pre-sorted events**

In `core/stream.ts`, modify `buildTimeline` to NOT re-sort. The events come in oldest-first from the paginated query. Remove or make optional the existing sort. The function should preserve input order.

- [ ] **Step 5: Update stream endpoint for pagination**

In `core/server.ts`, modify the GET `/api/work-item/:id/stream` handler:

1. Read `limit` and `before` from query params: `const limit = Number(c.req.query("limit")) || 10;` and `const before = c.req.query("before") || undefined;`
2. Call `graph.getEventsForWorkItemPaginated(id, limit, before)` instead of `graph.getEventsForWorkItem(id)`
3. Pass the events to `buildTimeline` as before
4. Add `hasOlder` to the response object

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/server/stream-api.test.ts`
Expected: All tests PASS (new and existing)

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add core/graph/index.ts core/server.ts core/stream.ts tests/server/stream-api.test.ts
git commit -m "feat: add timeline pagination and oldest-first ordering for chat-style display"
```

---

## Task 5: Frontend — API client updates

**Files:**
- Modify: `src/lib/api.ts`

### Context

Update the frontend API client with new types, functions, and modified return types to support all backend changes. This task has no tests (frontend API client is a thin wrapper; tested via integration).

Read this file before starting:
- `src/lib/api.ts` — all types and functions (514 lines)

- [ ] **Step 1: Add new types**

Add to `src/lib/api.ts`:

```typescript
export type StreamFilter = "needs-me" | "all-active" | "snoozed";

export interface ActionResponse {
  ok: boolean;
  delivered: boolean;
}

export interface PinResponse {
  ok: boolean;
  pinned: boolean;
}

// Add to existing StreamData interface:
// hasOlder: boolean;

// Add to existing WorkItem type (if not already present):
// pinned: boolean;
// dismissedAt: string | null;
```

Update the `StreamData` interface to include `hasOlder: boolean`.

Update the `WorkItem` type to include `pinned: boolean` and `dismissedAt: string | null`.

- [ ] **Step 2: Add new fetch functions**

```typescript
export async function fetchAllActive(): Promise<{ items: ActionableItem[] }> {
  return get("/api/stream/all-active");
}

export async function togglePin(workItemId: string): Promise<PinResponse> {
  return post(`/api/work-item/${workItemId}/pin`, {});
}
```

- [ ] **Step 3: Update postAction return type**

Change `postAction` to return `Promise<ActionResponse>` instead of `Promise<{ ok: boolean }>`.

- [ ] **Step 4: Update fetchStream signature**

Add optional pagination params:

```typescript
export async function fetchStream(
  workItemId: string,
  options?: { limit?: number; before?: string },
): Promise<StreamData> {
  let url = `/api/work-item/${workItemId}/stream`;
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return get(url);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: update API client with new types, endpoints, and pagination support"
```

---

## Task 6: Frontend — StreamView layout and FilterTabs

**Files:**
- Create: `src/components/StreamView.tsx`
- Create: `src/components/stream/FilterTabs.tsx`
- Modify: `src/components/App.tsx`

### Context

The core layout restructure. StreamView replaces Inbox as the main Stream view. It renders a two-panel layout: StreamList (left, 45%) and StreamDetail (right, 55%). FilterTabs sits at the top of the left panel. StreamView owns the polling loop and state management.

Read these files before starting:
- `src/components/Inbox.tsx` — current Stream view (110 lines), understand the polling and state pattern
- `src/components/App.tsx` — see how Inbox is rendered (look for `view === "stream"`)
- `src/lib/api.ts` — fetchInbox, fetchAllActive, fetchAgents

- [ ] **Step 1: Create FilterTabs component**

Create `src/components/stream/FilterTabs.tsx`:

```tsx
import type { StreamFilter } from "../../lib/api";

interface FilterTabsProps {
  active: StreamFilter;
  counts: { needsMe: number; allActive: number; snoozed: number };
  onChange: (filter: StreamFilter) => void;
}

const TABS: { id: StreamFilter; label: string; countKey: keyof FilterTabsProps["counts"] }[] = [
  { id: "needs-me", label: "Needs me", countKey: "needsMe" },
  { id: "all-active", label: "All active", countKey: "allActive" },
  { id: "snoozed", label: "Snoozed", countKey: "snoozed" },
];

export default function FilterTabs({ active, counts, onChange }: FilterTabsProps) {
  return (
    <div className="flex gap-2 px-4 py-2 border-b border-gray-800">
      {TABS.map(({ id, label, countKey }) => {
        const count = counts[countKey];
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
              isActive
                ? "bg-cyan-900/40 text-cyan-400"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`ml-1.5 px-1.5 rounded-full text-[10px] ${
                  isActive ? "bg-cyan-700 text-white" : "bg-gray-700 text-gray-400"
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create StreamView component**

Create `src/components/StreamView.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import {
  fetchInbox, fetchAllActive, fetchAgents,
  type ActionableItem, type StreamFilter, type Mentionable,
} from "../lib/api";
import FilterTabs from "./stream/FilterTabs";

const POLL_INTERVAL = 5000;

interface StreamViewProps {
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
}

export default function StreamView({
  mentionables,
  serializeMention,
}: StreamViewProps): JSX.Element {
  const [filter, setFilter] = useState<StreamFilter>("needs-me");
  const [needsMeItems, setNeedsMeItems] = useState<ActionableItem[]>([]);
  const [allActiveItems, setAllActiveItems] = useState<ActionableItem[]>([]);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [inbox, allActive] = await Promise.all([
        fetchInbox(),
        fetchAllActive(),
      ]);
      setNeedsMeItems(inbox.items);
      setAllActiveItems(allActive.items);
      setError(null);

      // Update dock badge count (macOS)
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("plugin:badger|set_count", { count: inbox.items.length });
      } catch { /* not in Tauri */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    }
  }, []);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

  const currentItems = (() => {
    switch (filter) {
      case "needs-me": return needsMeItems;
      case "all-active": return allActiveItems;
      case "snoozed": return needsMeItems.filter(i => i.workItem.snoozedUntil);
    }
  })();

  const snoozedCount = needsMeItems.filter(i => i.workItem.snoozedUntil).length;
  const counts = {
    needsMe: needsMeItems.filter(i => !i.workItem.snoozedUntil).length,
    allActive: allActiveItems.length,
    snoozed: snoozedCount,
  };

  function handleActioned() {
    setTimeout(poll, 500);
  }

  function handleSelect(id: string) {
    setSelectedWorkItemId(prev => prev === id ? null : id);
  }

  return (
    <div className="flex h-full">
      {/* Left panel: list */}
      <div className="w-[45%] min-w-[300px] border-r border-gray-800 flex flex-col overflow-hidden">
        <FilterTabs active={filter} counts={counts} onChange={setFilter} />
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-2 text-xs text-red-400">{error}</div>
          )}
          {currentItems.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {filter === "needs-me"
                ? "All clear. No items need your attention."
                : filter === "snoozed"
                  ? "No snoozed items."
                  : "No active work items."}
            </div>
          )}
          {/* StreamListItem components will go here in Task 7 */}
          {currentItems.map(item => (
            <div
              key={item.workItem.id}
              onClick={() => handleSelect(item.workItem.id)}
              className={`px-4 py-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-900/50 transition-colors ${
                selectedWorkItemId === item.workItem.id ? "bg-gray-900/80 border-l-2 border-l-cyan-500" : ""
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="text-xs font-semibold text-gray-200">{item.workItem.id}</span>
                <span className="text-[10px] text-gray-500">
                  {item.latestEvent?.timestamp
                    ? new Date(item.latestEvent.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : ""}
                </span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5 truncate">{item.workItem.title}</div>
              <div className="text-[10px] text-gray-600 mt-0.5">{item.agent?.name ?? "Unknown"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel: detail */}
      <div className="flex-1 overflow-hidden">
        {selectedWorkItemId ? (
          <div className="h-full">
            {/* StreamDetail will replace this placeholder in Task 8 */}
            <div className="p-4 text-gray-400 text-sm">
              Detail panel for {selectedWorkItemId}
              {/* WorkItemStream import will be wired here */}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-gray-500 text-sm">
                {counts.needsMe > 0
                  ? `${counts.needsMe} item${counts.needsMe !== 1 ? "s" : ""} need${counts.needsMe === 1 ? "s" : ""} you`
                  : "All clear"}
              </div>
              <div className="text-gray-700 text-xs mt-1">
                {allActiveItems.length} active across fleet
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire StreamView into App.tsx**

In `src/components/App.tsx`:
1. Replace the import of `Inbox` (or `Stream`) with `StreamView`
2. In the render section where `view === "stream"`, replace `<Stream ... />` with `<StreamView mentionables={mentionables} serializeMention={serializeMention} />`
3. Pass the necessary props (mentionables, serializeMention are already computed in App.tsx for the current Inbox)

- [ ] **Step 4: Verify the app builds**

Run: `npx vite build` or `npm run build`
Expected: Build succeeds (even if detail panel is a placeholder)

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamView.tsx src/components/stream/FilterTabs.tsx src/components/App.tsx
git commit -m "feat: add StreamView layout with FilterTabs and two-panel structure"
```

---

## Task 7: Frontend — StreamListItem with status badges and action states

**Files:**
- Create: `src/components/stream/StreamListItem.tsx`
- Modify: `src/components/StreamView.tsx`
- Modify: `src/components/StatusBadge.tsx`

### Context

Replace the placeholder list items in StreamView with proper StreamListItem components showing status badges, action states, agent info, and left border color coding.

Read these files before starting:
- `src/components/WorkItemCard.tsx` — current card component (267 lines), understand what data it displays
- `src/components/StatusBadge.tsx` — current badge component (40 lines)
- `src/components/StreamView.tsx` — the placeholder list items from Task 6

- [ ] **Step 1: Extend StatusBadge with action states**

In `src/components/StatusBadge.tsx`, add new badge variants for action states. The existing badge maps `StatusCategory` to colors. Add a new optional `actionState` prop:

```tsx
export type ActionState = "replied" | "unblocked" | "done" | "snoozed" | null;

interface StatusBadgeProps {
  status: string;
  actionState?: ActionState;
  snoozedUntil?: string | null;
}
```

When `actionState` is set, it overrides the status display:
- `replied` → green badge, "Replied" label
- `unblocked` → green badge with checkmark, "✓ Unblocked"
- `done` → green badge with checkmark, "✓ Done"
- `snoozed` → amber badge, "Snoozed Xh" (compute remaining time from snoozedUntil)

When `actionState` is null, show the original status badge.

- [ ] **Step 2: Create StreamListItem**

Create `src/components/stream/StreamListItem.tsx`:

```tsx
import { type ActionableItem } from "../../lib/api";
import StatusBadge, { type ActionState } from "../StatusBadge";

const BORDER_COLORS: Record<string, string> = {
  blocked_on_human: "border-l-red-500",
  needs_decision: "border-l-amber-500",
  in_progress: "border-l-blue-500",
  completed: "border-l-green-500",
  noise: "border-l-gray-600",
};

interface StreamListItemProps {
  item: ActionableItem;
  selected: boolean;
  actionState: ActionState;
  onSelect: () => void;
}

export default function StreamListItem({ item, selected, actionState, onSelect }: StreamListItemProps) {
  const { workItem, latestEvent, agent } = item;
  const status = workItem.currentAtcStatus ?? "noise";
  const borderColor = BORDER_COLORS[status] ?? "border-l-gray-600";
  const isSnoozed = Boolean(workItem.snoozedUntil);
  const isPinned = workItem.pinned;

  const timeAgo = latestEvent?.timestamp
    ? formatRelativeTime(new Date(latestEvent.timestamp))
    : "";

  return (
    <div
      onClick={onSelect}
      className={`
        px-4 py-3 border-b border-gray-800/50 border-l-[3px] cursor-pointer
        transition-all duration-200
        ${borderColor}
        ${selected ? "bg-gray-900/80" : "hover:bg-gray-900/40"}
        ${isSnoozed ? "opacity-50" : ""}
      `}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 min-w-0">
          {isPinned && <span className="text-[10px] text-gray-600">📌</span>}
          <span className="text-xs font-semibold text-gray-200 truncate">{workItem.id}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge
            status={status}
            actionState={actionState}
            snoozedUntil={workItem.snoozedUntil}
          />
          <span className="text-[10px] text-gray-600">{timeAgo}</span>
        </div>
      </div>
      <div className="text-xs text-gray-400 mt-1 truncate">{workItem.title}</div>
      <div className="text-[10px] text-gray-600 mt-0.5">
        {agent?.name ?? "Unknown"}
        {latestEvent?.reason && (
          <span className="ml-1 text-gray-700">· {truncate(latestEvent.reason, 60)}</span>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
```

- [ ] **Step 3: Wire StreamListItem into StreamView**

In `src/components/StreamView.tsx`, replace the placeholder `<div>` items with `<StreamListItem>` components. Add action state tracking:

1. Add state: `const [actionStates, setActionStates] = useState<Map<string, ActionState>>(new Map());`
2. Replace the inline item divs with:
```tsx
<StreamListItem
  key={item.workItem.id}
  item={item}
  selected={selectedWorkItemId === item.workItem.id}
  actionState={actionStates.get(item.workItem.id) ?? null}
  onSelect={() => handleSelect(item.workItem.id)}
/>
```
3. Add a function to set action state that auto-clears after a delay for resolved actions.

- [ ] **Step 4: Sort items: pinned first, then by timestamp**

In StreamView, before rendering the list, sort `currentItems`:
```typescript
const sortedItems = [...currentItems].sort((a, b) => {
  // Pinned items first
  if (a.workItem.pinned && !b.workItem.pinned) return -1;
  if (!a.workItem.pinned && b.workItem.pinned) return 1;
  // Then by latest event timestamp (newest first)
  const tA = a.latestEvent?.timestamp ?? a.workItem.updatedAt;
  const tB = b.latestEvent?.timestamp ?? b.workItem.updatedAt;
  return new Date(tB).getTime() - new Date(tA).getTime();
});
```

- [ ] **Step 5: Verify the app builds and list renders correctly**

Run: `npx vite build`
Expected: Build succeeds. List items show with proper status badges and styling.

- [ ] **Step 6: Commit**

```bash
git add src/components/stream/StreamListItem.tsx src/components/StreamView.tsx src/components/StatusBadge.tsx
git commit -m "feat: add StreamListItem with status badges, action states, and pin indicators"
```

---

## Task 8: Frontend — StreamDetail (persistent right panel)

**Files:**
- Create: `src/components/stream/StreamDetail.tsx`
- Modify: `src/components/StreamView.tsx`
- Modify: `src/components/stream/Timeline.tsx`
- Modify: `src/components/stream/SuggestedActions.tsx`

### Context

Refactor WorkItemStream (currently a modal overlay) into StreamDetail (a persistent panel within the two-panel layout). Key changes: no backdrop/overlay, no ESC-to-close, persistent within the layout. Timeline changes to chat-style (oldest first) with auto-scroll to bottom and load-older on scroll up. SuggestedActions adds Noise button and pin toggle.

Read these files before starting:
- `src/components/WorkItemStream.tsx` — current detail pane (152 lines)
- `src/components/stream/Timeline.tsx` — current timeline (70 lines)
- `src/components/stream/TimelineEntry.tsx` — entry rendering (62 lines)
- `src/components/stream/SuggestedActions.tsx` — current actions (119 lines)
- `src/components/stream/StatusSnapshot.tsx` — header component (75 lines)

- [ ] **Step 1: Modify Timeline to chat-style with auto-scroll and load-older**

In `src/components/stream/Timeline.tsx`:

1. Change the component to accept `hasOlder: boolean` and `onLoadOlder: () => void` props
2. Events are now in oldest-first order (backend sends them this way after Task 4)
3. Remove the collapsible/grouped rendering — show a flat chat-style list
4. Add a ref on the scroll container and auto-scroll to bottom on mount and when new entries arrive
5. Add a "Load older messages" button at the top when `hasOlder` is true

```tsx
import { useEffect, useRef, type JSX } from "react";
import type { TimelineEntry } from "../../lib/api";

interface TimelineProps {
  entries: TimelineEntry[];
  hasOlder: boolean;
  onLoadOlder: () => void;
}

export default function Timeline({ entries, hasOlder, onLoadOlder }: TimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(entries.length);

  // Auto-scroll to bottom on mount and when new entries arrive at the end
  useEffect(() => {
    if (entries.length >= prevLengthRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: entries.length === prevLengthRef.current ? "auto" : "smooth" });
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
      {hasOlder && (
        <button
          onClick={onLoadOlder}
          className="w-full text-center text-[10px] text-gray-600 hover:text-gray-400 py-2 cursor-pointer"
        >
          Load older messages
        </button>
      )}
      {entries.length === 0 && (
        <div className="text-center text-gray-600 text-xs py-8">No timeline events</div>
      )}
      {entries.map((entry) => (
        <TimelineBubble key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function TimelineBubble({ entry }: { entry: TimelineEntry }): JSX.Element {
  const isOperator = entry.isOperator;
  const borderColor = entry.status === "blocked_on_human"
    ? "border-l-red-500/40"
    : entry.status === "needs_decision"
      ? "border-l-amber-500/40"
      : isOperator
        ? "border-l-green-500/40"
        : "border-l-gray-700";

  return (
    <div className={`border-l-2 ${borderColor} pl-3 mb-4`}>
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-medium ${
          isOperator ? "bg-green-900/40 text-green-400" : "bg-gray-800 text-cyan-400"
        }`}>
          {isOperator ? "Y" : (entry.agentName?.[0] ?? "?")}
        </div>
        <span className={`text-[9px] font-medium ${isOperator ? "text-green-400" : "text-cyan-400"}`}>
          {isOperator ? "You" : entry.agentName ?? "Unknown"}
        </span>
        <span className="text-[8px] text-gray-600">
          {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className={`text-[10px] rounded-md px-2.5 py-2 leading-relaxed ${
        isOperator ? "bg-green-900/20 text-gray-200 border border-green-900/30" : "bg-gray-900 text-gray-300"
      }`}>
        {entry.rawText || entry.summary}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update SuggestedActions with Noise, Snooze dropdown, and Pin**

In `src/components/stream/SuggestedActions.tsx`:

1. Add `noise` to the `ActionKind` type and `ACTION_BUTTONS` array:
```typescript
{ action: "noise", label: "Noise", classes: "bg-gray-800/70 hover:bg-gray-700 text-gray-400" }
```
2. Map `noise` in `toServerAction`: `case "noise": return "noise";`
3. Add `pinned: boolean` and `onTogglePin: () => void` to the props
4. Add a pin toggle button in the action row:
```tsx
<button onClick={onTogglePin} className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-gray-700/50 hover:bg-gray-600 text-gray-400">
  {pinned ? "Unpin" : "Pin"}
</button>
```

- [ ] **Step 3: Create StreamDetail component**

Create `src/components/stream/StreamDetail.tsx`. This is a refactored version of WorkItemStream without the modal overlay:

```tsx
import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchStream, postReply, togglePin, type StreamData, type Mentionable, type ActionState } from "../../lib/api";
import StatusSnapshot from "./StatusSnapshot";
import Timeline from "./Timeline";
import SuggestedActions from "./SuggestedActions";
import MentionInput, { type MentionInputHandle } from "../MentionInput";

interface StreamDetailProps {
  workItemId: string;
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
  onActioned?: () => void;
  onActionStateChange?: (workItemId: string, state: ActionState) => void;
}

export default function StreamDetail({
  workItemId,
  mentionables,
  serializeMention,
  onActioned,
  onActionStateChange,
}: StreamDetailProps): JSX.Element {
  const [data, setData] = useState<StreamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const replyInputRef = useRef<MentionInputHandle>(null);

  const loadStream = useCallback(async (before?: string) => {
    try {
      const d = await fetchStream(workItemId, { limit: 10, before });
      if (before && data) {
        // Prepend older events
        setData(prev => prev ? {
          ...d,
          timeline: [...d.timeline, ...prev.timeline],
        } : d);
      } else {
        setData(d);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [workItemId, data]);

  useEffect(() => {
    setData(null);
    setError(null);
    loadStream();
  }, [workItemId]);

  function handleActioned() {
    loadStream();
    onActioned?.();
  }

  function getReplyText(): string | undefined {
    return replyInputRef.current?.serialize() || undefined;
  }

  function handleActionComplete(actionType: string) {
    replyInputRef.current?.clear();
    // Map action to action state for the list item
    const stateMap: Record<string, ActionState> = {
      redirect: "unblocked",
      approve: "done",
    };
    onActionStateChange?.(workItemId, stateMap[actionType] ?? null);
    handleActioned();
  }

  async function handleReply(serializedText: string) {
    if (!serializedText.trim() || !data) return;
    setSending(true);
    try {
      await postReply(
        data.latestThreadId ?? undefined,
        data.latestChannelId ?? undefined,
        serializedText,
        { workItemId },
      );
      replyInputRef.current?.clear();
      onActionStateChange?.(workItemId, "replied");
      handleActioned();
    } catch {
      // Keep text so user can retry
    } finally {
      setSending(false);
    }
  }

  async function handleTogglePin() {
    const result = await togglePin(workItemId);
    if (data) {
      setData({ ...data, workItem: { ...data.workItem, pinned: result.pinned } });
    }
    onActioned?.();
  }

  function handleLoadOlder() {
    if (data && data.timeline.length > 0) {
      const oldestTimestamp = data.timeline[0].timestamp;
      loadStream(oldestTimestamp);
    }
  }

  if (error && !data) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="text-sm text-red-400">{error}</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-5 space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-gray-900 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <StatusSnapshot data={data} pinned={data.workItem.pinned} onTogglePin={handleTogglePin} />
      <Timeline
        entries={data.timeline}
        hasOlder={data.hasOlder ?? false}
        onLoadOlder={handleLoadOlder}
      />
      <div className="border-t border-gray-800">
        <SuggestedActions
          data={data}
          onActioned={handleActioned}
          getReplyText={getReplyText}
          onActionComplete={handleActionComplete}
          pinned={data.workItem.pinned}
          onTogglePin={handleTogglePin}
        />
        <div className="px-5 pb-3">
          <MentionInput
            ref={replyInputRef}
            placeholder="Reply to thread…"
            disabled={sending}
            mentionables={mentionables}
            serializeMention={serializeMention}
            onSubmit={handleReply}
          />
          {data.latestThreadId && data.channels.length > 0 && (
            <div className="text-[10px] text-gray-600 mt-1">
              → replies to latest thread in #{data.channels[0].name}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire StreamDetail into StreamView**

In `src/components/StreamView.tsx`, replace the detail panel placeholder with:

```tsx
import StreamDetail from "./stream/StreamDetail";

// In the right panel section:
{selectedWorkItemId ? (
  <StreamDetail
    key={selectedWorkItemId}
    workItemId={selectedWorkItemId}
    mentionables={mentionables}
    serializeMention={serializeMention}
    onActioned={handleActioned}
    onActionStateChange={(id, state) => {
      setActionStates(prev => new Map(prev).set(id, state));
    }}
  />
) : (
  // ... empty state
)}
```

- [ ] **Step 5: Update StatusSnapshot props for pin**

In `src/components/stream/StatusSnapshot.tsx`, add `pinned: boolean` and `onTogglePin: () => void` to props. Add a pin button in the header area.

- [ ] **Step 6: Verify app builds and detail panel works**

Run: `npx vite build`
Expected: Build succeeds. Selecting a list item shows the detail panel with timeline, actions, and reply.

- [ ] **Step 7: Commit**

```bash
git add src/components/stream/StreamDetail.tsx src/components/stream/Timeline.tsx src/components/stream/SuggestedActions.tsx src/components/stream/StatusSnapshot.tsx src/components/StreamView.tsx
git commit -m "feat: add StreamDetail with chat-style timeline, noise action, and pin support"
```

---

## Task 9: Frontend — SnoozeDropdown

**Files:**
- Create: `src/components/stream/SnoozeDropdown.tsx`
- Modify: `src/components/stream/SuggestedActions.tsx`

### Context

Replace the hardcoded snooze button with a dropdown that lets the operator pick a duration: 30m, 1h, 3h, Tomorrow morning, Next Monday, Custom. The dropdown sends the actual duration in seconds to the server.

Read `src/components/stream/SuggestedActions.tsx` before starting.

- [ ] **Step 1: Create SnoozeDropdown**

Create `src/components/stream/SnoozeDropdown.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";

interface SnoozeDropdownProps {
  disabled: boolean;
  onSnooze: (durationSeconds: number) => void;
}

interface SnoozeOption {
  label: string;
  seconds: number | (() => number);
}

const SNOOZE_OPTIONS: SnoozeOption[] = [
  { label: "30 minutes", seconds: 30 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "3 hours", seconds: 3 * 60 * 60 },
  {
    label: "Tomorrow morning",
    seconds: () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return Math.max(60, Math.floor((tomorrow.getTime() - Date.now()) / 1000));
    },
  },
  {
    label: "Next Monday",
    seconds: () => {
      const now = new Date();
      const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() + daysUntilMonday);
      monday.setHours(9, 0, 0, 0);
      return Math.max(60, Math.floor((monday.getTime() - Date.now()) / 1000));
    },
  },
];

export default function SnoozeDropdown({ disabled, onSnooze }: SnoozeDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function handleSelect(option: SnoozeOption) {
    const seconds = typeof option.seconds === "function" ? option.seconds() : option.seconds;
    onSnooze(seconds);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-amber-800/70 hover:bg-amber-700 text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
      >
        Snooze <span className="text-[9px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 bg-gray-900 border border-gray-700 rounded-lg py-1 shadow-xl min-w-[160px] z-20">
          {SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.label}
              onClick={() => handleSelect(option)}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 cursor-pointer"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace snooze button in SuggestedActions**

In `src/components/stream/SuggestedActions.tsx`:

1. Remove "snooze" from the ACTION_BUTTONS array
2. Import and render SnoozeDropdown after the action buttons:
```tsx
import SnoozeDropdown from "./SnoozeDropdown";

// In the button row, after the regular buttons:
<SnoozeDropdown
  disabled={busy}
  onSnooze={(seconds) => handleAction("snooze", seconds)}
/>
```
3. Update `handleAction` to accept an optional `snoozeDuration` parameter and pass it through to `postAction`.

- [ ] **Step 3: Verify dropdown renders and works**

Run: `npx vite build`
Expected: Build succeeds. Snooze button shows dropdown with time options.

- [ ] **Step 4: Commit**

```bash
git add src/components/stream/SnoozeDropdown.tsx src/components/stream/SuggestedActions.tsx
git commit -m "feat: add SnoozeDropdown with preset and computed time options"
```

---

## Task 10: Frontend — Auto-resolve animations and send confirmation

**Files:**
- Modify: `src/components/StreamView.tsx`
- Modify: `src/components/stream/StreamListItem.tsx`
- Create: `src/components/stream/SendConfirmation.tsx`
- Modify: `src/components/stream/StreamDetail.tsx`
- Modify: `src/index.css`

### Context

This task adds the animated feedback loop: when the operator acts, the list item transitions (badge change → fade out), the detail panel shows inline Slack delivery confirmation, and the item auto-resolves from the "Needs me" list.

Read these files before starting:
- `src/components/StreamView.tsx` — to understand action state flow
- `src/components/stream/StreamListItem.tsx` — to add exit animation
- `src/components/stream/StreamDetail.tsx` — to add send confirmation display
- `src/index.css` — to add keyframe animations

- [ ] **Step 1: Add CSS animations**

In `src/index.css`, add:

```css
@keyframes list-item-enter {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes list-item-exit {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(4px); }
}

@keyframes input-success {
  0% { border-color: rgb(34 197 94 / 0.6); box-shadow: 0 0 12px rgb(34 197 94 / 0.2); }
  100% { border-color: rgb(55 65 81); box-shadow: none; }
}

@keyframes input-error {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}

@keyframes badge-pop {
  0% { transform: scale(1); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}

.animate-list-enter { animation: list-item-enter 0.2s ease-out; }
.animate-list-exit { animation: list-item-exit 0.3s ease-in forwards; }
.animate-input-success { animation: input-success 0.8s ease forwards; }
.animate-input-error { animation: input-error 0.4s ease; }
.animate-badge-pop { animation: badge-pop 0.3s ease; }
```

- [ ] **Step 2: Add enter/exit animations to StreamListItem**

In `src/components/stream/StreamListItem.tsx`:

1. Add a `resolving: boolean` prop
2. When `resolving` is true, add the `animate-list-exit` class
3. New items get `animate-list-enter` class on mount (use a ref + useEffect to detect first render)

- [ ] **Step 3: Create SendConfirmation component**

Create `src/components/stream/SendConfirmation.tsx`:

```tsx
import { useState, useEffect } from "react";

interface SendConfirmationProps {
  channelName: string;
  action: string;
  onComplete: () => void;
}

export default function SendConfirmation({ channelName, action, onComplete }: SendConfirmationProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setStep(1), 400),   // checkmark
      setTimeout(() => setStep(2), 1000),   // delivery confirmation
      setTimeout(() => setStep(3), 2000),   // resolve message
      setTimeout(onComplete, 3000),          // cleanup
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  const actionLabels: Record<string, string> = {
    redirect: "Unblocked",
    approve: "Done",
    close: "Dismissed",
    noise: "Classified as noise",
  };

  return (
    <div className="text-center py-3">
      {step >= 1 && (
        <div className="text-[10px] text-green-400 animate-fade-in">
          ✓ Sent to #{channelName}
        </div>
      )}
      {step >= 2 && (
        <div className="text-[10px] text-green-500/70 mt-1 animate-fade-in">
          💬 Delivered to Slack · #{channelName} thread
        </div>
      )}
      {step >= 3 && (
        <div className="mt-2">
          <div className="text-[10px] text-green-400 font-medium">
            ✓ {actionLabels[action] ?? "Done"} · leaving stream
          </div>
          <div className="text-[9px] text-gray-600 mt-0.5">
            Will reappear if agent needs you again
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire send confirmation into StreamDetail**

In `src/components/stream/StreamDetail.tsx`:

1. Add state: `const [confirmation, setConfirmation] = useState<{ action: string; channelName: string } | null>(null);`
2. When `handleActionComplete` fires with a delivered response, set confirmation state
3. Render `<SendConfirmation>` at the bottom of the timeline when active
4. On completion, clear the confirmation state

- [ ] **Step 5: Wire auto-resolve into StreamView**

In `src/components/StreamView.tsx`:

1. Add state: `const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());`
2. When an action state is set to "unblocked" or "done", add the work item ID to resolvingIds
3. After a 2-second delay, remove the item from the displayed list (the next poll will naturally exclude it)
4. Pass `resolving={resolvingIds.has(item.workItem.id)}` to StreamListItem

- [ ] **Step 6: Verify animations work**

Run: `npx vite build`
Expected: Build succeeds. Acting on an item triggers badge transition, send confirmation, and fade-out.

- [ ] **Step 7: Commit**

```bash
git add src/index.css src/components/stream/StreamListItem.tsx src/components/stream/SendConfirmation.tsx src/components/stream/StreamDetail.tsx src/components/StreamView.tsx
git commit -m "feat: add auto-resolve animations and send confirmation sequence"
```

---

## Task 11: Frontend — Liveness signals and sync indicator

**Files:**
- Modify: `src/components/App.tsx`
- Modify: `src/components/StreamView.tsx`

### Context

Add sync indicator to the existing title bar in App.tsx. StreamView exposes its sync state (last poll time, connection status) via a callback to App. The title bar shows a green/yellow/red dot with "Live · synced Xs ago" text.

Read these files before starting:
- `src/components/App.tsx` — see the title bar rendering (look for the service status dots area)
- `src/components/StreamView.tsx` — polling logic

- [ ] **Step 1: Add sync state to StreamView**

In `src/components/StreamView.tsx`:

1. Add state: `const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);` and `const [syncError, setSyncError] = useState(false);`
2. In the `poll` function, set `setLastSyncAt(new Date())` on success and `setSyncError(true)` on failure
3. Add a new prop: `onSyncStateChange?: (state: { lastSyncAt: Date | null; error: boolean }) => void`
4. Call `onSyncStateChange` whenever sync state changes

- [ ] **Step 2: Add sync indicator to App.tsx title bar**

In `src/components/App.tsx`:

1. Add state: `const [syncState, setSyncState] = useState<{ lastSyncAt: Date | null; error: boolean }>({ lastSyncAt: null, error: false });`
2. Pass `onSyncStateChange={setSyncState}` to StreamView
3. In the title bar area (near the service status dots), add a sync indicator:

```tsx
function SyncIndicator({ lastSyncAt, error }: { lastSyncAt: Date | null; error: boolean }) {
  const [, forceUpdate] = useState(0);

  // Update relative time every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!lastSyncAt) return null;

  const secondsAgo = Math.floor((Date.now() - lastSyncAt.getTime()) / 1000);
  const isStale = secondsAgo > 30;

  const dotColor = error
    ? "bg-red-500"
    : isStale
      ? "bg-amber-500"
      : "bg-green-500";

  const label = error
    ? "Reconnecting..."
    : isStale
      ? `Last synced ${secondsAgo}s ago`
      : `Live · synced ${secondsAgo}s ago`;

  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="text-[10px] text-gray-600">{label}</span>
    </div>
  );
}
```

4. Render `<SyncIndicator {...syncState} />` in the title bar between the app name and the service dots.

- [ ] **Step 3: Verify sync indicator updates**

Run: `npx vite build`
Expected: Build succeeds. Title bar shows "Live · synced Xs ago" that updates every second.

- [ ] **Step 4: Commit**

```bash
git add src/components/App.tsx src/components/StreamView.tsx
git commit -m "feat: add live sync indicator in title bar"
```

---

## Task 12: Cleanup — Remove old Inbox, wire remaining props

**Files:**
- Delete or archive: `src/components/Inbox.tsx`
- Modify: `src/components/App.tsx`
- Modify: `src/components/FleetBoard.tsx`

### Context

Final cleanup: remove the old Inbox component (replaced by StreamView), ensure FleetBoard's detail pane click still works (it currently opens WorkItemStream as a modal — keep that behavior for now, or wire it to the same StreamDetail pattern). Remove any unused imports.

Read these files before starting:
- `src/components/App.tsx` — verify StreamView is wired correctly and Inbox import is removed
- `src/components/Inbox.tsx` — to confirm it's no longer referenced
- `src/components/FleetBoard.tsx` — to check if it uses WorkItemStream (it does — clicking a row opens the detail pane)

- [ ] **Step 1: Remove Inbox.tsx import from App.tsx**

In `src/components/App.tsx`:
1. Remove the import of `Inbox` (or `Stream` — check the actual import name)
2. Confirm StreamView is already rendered for `view === "stream"` (from Task 6)
3. Remove any unused state or handlers that were specific to the old Inbox

- [ ] **Step 2: Keep FleetBoard's detail pane working**

FleetBoard currently opens WorkItemStream as a modal overlay on row click. Keep this behavior for now — the Fleet view redesign is a separate brainstorm. Just verify it still works with the existing WorkItemStream component.

- [ ] **Step 3: Delete Inbox.tsx**

```bash
git rm src/components/Inbox.tsx
```

- [ ] **Step 4: Verify everything builds and works**

Run: `npx vite build`
Expected: Build succeeds with no unused import warnings for Inbox.

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old Inbox component, StreamView is now the primary Stream view"
```

---

## Self-Review

### Spec Coverage

| Spec Section | Task(s) |
|---|---|
| Stream + Fleet tabs | Task 6 (App.tsx wiring) |
| List + persistent detail panel (45/55) | Task 6 (StreamView layout) |
| Filter tabs: Needs me / All active / Snoozed | Task 3 (backend endpoint), Task 6 (FilterTabs) |
| One entry per work item, dedup | Task 7 (StreamListItem), backend already returns one per work item |
| Action state tracking (Replied, Unblocked) | Task 7 (StatusBadge action states), Task 8 (StreamDetail callbacks) |
| Pinning | Task 1 (backend), Task 8 (StreamDetail pin toggle) |
| Auto-resolve with fade animation | Task 10 (animations, resolving state) |
| Chat-style timeline, auto-scroll, load-older | Task 4 (backend pagination), Task 8 (Timeline refactor) |
| Dismiss vs Noise actions | Task 2 (backend), Task 8 (SuggestedActions) |
| Snooze dropdown with time picker | Task 9 (SnoozeDropdown) |
| Snooze auto-break on new activity | Existing behavior: snoozed_until check in getActionableItems already handles this (item re-enters when new event's targeted_at_operator is true and time passes snoozed_until) |
| Liveness: sync indicator | Task 11 (SyncIndicator in title bar) |
| Liveness: list animations | Task 10 (CSS animations, enter/exit) |
| Send confirmation animation | Task 10 (SendConfirmation component) |
| Optional confirmation sound | Not included — deferred to polish phase. Simple `new Audio().play()` call in SendConfirmation, gated by user preference. Can be added as a small follow-up. |
| User preferences (snooze visibility, sound) | Not included — deferred. Requires settings UI work. Snooze items show dimmed by default. |
| Delivered field in action response | Task 2 (backend) |
| Empty state | Task 6 (StreamView) |
| Desktop layout / mobile drill-in | Task 6 (desktop layout). Mobile responsive is a CSS-only follow-up. |

### Deferred Items (not in this plan)
- **Optional confirmation sound** — trivial to add post-merge, needs user preference storage
- **User preferences** (snooze visibility toggle, sound toggle) — needs settings UI, separate small task
- **Mobile responsive layout** — CSS breakpoint work, no architectural changes needed
- **Dismiss visibility logic** (show in Needs me, hide in All active) — minor conditional in SuggestedActions, can be added during implementation

### Placeholder Scan
No TBDs, TODOs, or "implement later" found.

### Type Consistency
- `ActionState` type used consistently: defined in StatusBadge, imported in StreamListItem, StreamDetail, StreamView
- `StreamFilter` type: defined in api.ts, used in FilterTabs and StreamView
- `ActionResponse` / `PinResponse`: defined in api.ts, used in StreamDetail
- `StreamData.hasOlder`: added to api.ts type, returned by backend, consumed by Timeline
