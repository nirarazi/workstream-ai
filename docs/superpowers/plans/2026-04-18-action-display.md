# Action Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show actor-aware status lines ("Waiting on Guy") and next-action descriptions in the Fleet/Stream detail pane, backed by persisted `actionRequiredFrom` and `nextAction` fields.

**Architecture:** Add two columns to the events table, thread them through the graph and pipeline layers, extend `buildUnifiedStatus()` to resolve actor names against an `OperatorIdentityMap`, and render the `nextAction` line in the UI. Add `getAuthenticatedUser()` to the `TaskAdapter` interface so operator identities are collected from all adapters.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, React/Tailwind

---

### Task 1: Extend Event Type and Schema

Add `actionRequiredFrom` and `nextAction` to the `Event` type, `EventRow` schema, and run the DB migration.

**Files:**
- Modify: `core/types.ts:100-114` — add two fields to `Event` interface
- Modify: `core/graph/schema.ts:42-56` — add two fields to `EventRow`
- Modify: `core/graph/db.ts:235-241` — add migration for new columns
- Modify: `core/graph/index.ts:62-78` — update `toEvent()` mapper
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/graph/db.test.ts`, add a test that inserts an event with `actionRequiredFrom` and `nextAction`, then reads it back:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";

describe("Event actionRequiredFrom and nextAction persistence", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it("persists and retrieves actionRequiredFrom and nextAction", () => {
    graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Test" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });

    const event = graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-1",
      agentId: "a1",
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs approval",
      rawText: "Please approve PR #716",
      timestamp: new Date().toISOString(),
      targetedAtOperator: true,
      actionRequiredFrom: ["U_GUY123", "U_OPERATOR"],
      nextAction: "Review and approve PR #716",
    });

    expect(event.actionRequiredFrom).toEqual(["U_GUY123", "U_OPERATOR"]);
    expect(event.nextAction).toBe("Review and approve PR #716");
  });

  it("defaults actionRequiredFrom and nextAction to null when not provided", () => {
    graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Test2" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });

    const event = graph.insertEvent({
      threadId: "t2",
      messageId: "m2",
      workItemId: "AI-2",
      agentId: "a1",
      status: "in_progress",
      confidence: 0.8,
      reason: "Working on it",
      timestamp: new Date().toISOString(),
    });

    expect(event.actionRequiredFrom).toBeNull();
    expect(event.nextAction).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/db.test.ts --reporter=verbose`
Expected: FAIL — `actionRequiredFrom` and `nextAction` don't exist on `Event` type

- [ ] **Step 3: Add fields to Event type**

In `core/types.ts`, add two fields to the `Event` interface (after `targetedAtOperator` on line 113):

```typescript
  actionRequiredFrom: string[] | null;
  nextAction: string | null;
```

- [ ] **Step 4: Add fields to EventRow schema**

In `core/graph/schema.ts`, add two fields to the `EventRow` interface (after `targeted_at_operator` on line 55):

```typescript
  action_required_from: string | null;
  next_action: string | null;
```

- [ ] **Step 5: Add the DB migration**

In `core/graph/db.ts`, after the `targeted_at_operator` migration block (after line 240), add:

```typescript
    // Add action_required_from and next_action columns to events table
    const eventColsForAction = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColsForAction.some((c) => c.name === "action_required_from")) {
      this.db.exec("ALTER TABLE events ADD COLUMN action_required_from TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE events ADD COLUMN next_action TEXT DEFAULT NULL");
      log.info("Migration: added action_required_from and next_action columns to events");
    }
```

- [ ] **Step 6: Update toEvent() mapper**

In `core/graph/index.ts`, update the `toEvent()` function (lines 62-78) to deserialize the new fields:

```typescript
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
```

- [ ] **Step 7: Update insertEvent() to accept and persist new fields**

In `core/graph/index.ts`, update the `insertEvent()` method signature (around line 316) to accept:

```typescript
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
```

Update the SQL INSERT statement and the `stmt.run()` call to include the two new columns:

```typescript
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/graph/db.test.ts --reporter=verbose`
Expected: PASS — both new tests pass

- [ ] **Step 9: Run full test suite to check for regressions**

Run: `npx vitest run --reporter=verbose`
Expected: All existing tests still pass. Existing `insertEvent()` calls that don't pass the new fields use the defaults (null).

- [ ] **Step 10: Commit**

```bash
git add core/types.ts core/graph/schema.ts core/graph/db.ts core/graph/index.ts tests/graph/db.test.ts
git commit -m "feat: persist actionRequiredFrom and nextAction on events"
```

---

### Task 2: Add OperatorIdentityMap and TaskAdapter.getAuthenticatedUser()

Add the `OperatorIdentityMap` type and extend `TaskAdapter` with `getAuthenticatedUser()`. Implement it in the Jira adapter.

**Files:**
- Modify: `core/types.ts:18-21` — add `OperatorIdentityMap` type
- Modify: `core/adapters/tasks/interface.ts:13-30` — add optional `getAuthenticatedUser()`
- Modify: `core/adapters/tasks/jira/index.ts:205-228` — store authed user, expose via `getAuthenticatedUser()`
- Test: `tests/adapters/jira.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/adapters/jira.test.ts`, find the existing test file and add a new describe block. If the file uses mocked fetch, follow the same pattern:

```typescript
describe("JiraAdapter.getAuthenticatedUser", () => {
  it("returns null before connect", () => {
    const adapter = new JiraAdapter();
    expect(adapter.getAuthenticatedUser()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/jira.test.ts --reporter=verbose`
Expected: FAIL — `getAuthenticatedUser` does not exist on `JiraAdapter`

- [ ] **Step 3: Add OperatorIdentityMap type**

In `core/types.ts`, after the `OperatorIdentity` interface (after line 21), add:

```typescript
/** Operator identities keyed by adapter/platform name (e.g., "slack", "jira") */
export type OperatorIdentityMap = Map<string, OperatorIdentity>;
```

- [ ] **Step 4: Add getAuthenticatedUser to TaskAdapter interface**

In `core/adapters/tasks/interface.ts`, add inside the `TaskAdapter` interface (after line 23, after `connect`):

```typescript
  /** Return the authenticated user's identity (the operator). Null if not connected or not supported. */
  getAuthenticatedUser?(): { userId: string; userName: string } | null;
```

- [ ] **Step 5: Implement getAuthenticatedUser in JiraAdapter**

In `core/adapters/tasks/jira/index.ts`:

1. Add a private field alongside the other private fields at the top of the class:

```typescript
  private authedUser: { userId: string; userName: string } | null = null;
```

2. In the `connect()` method (line 225), after `const user = (await response.json()) as { displayName: string };`, update the type and store the user:

Change line 225 from:
```typescript
    const user = (await response.json()) as { displayName: string };
```
to:
```typescript
    const user = (await response.json()) as { displayName: string; emailAddress?: string; accountId?: string };
    this.authedUser = {
      userId: user.accountId ?? user.emailAddress ?? "",
      userName: user.displayName,
    };
```

3. Add the public method after `connect()`:

```typescript
  getAuthenticatedUser(): { userId: string; userName: string } | null {
    return this.authedUser;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/jira.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add core/types.ts core/adapters/tasks/interface.ts core/adapters/tasks/jira/index.ts tests/adapters/jira.test.ts
git commit -m "feat: add OperatorIdentityMap type and getAuthenticatedUser to TaskAdapter"
```

---

### Task 3: Collect Operator Identities in Server State

Add `operatorIdentities` to `EngineState`, populate it from all connected adapters, and pass it where needed.

**Files:**
- Modify: `core/server.ts:27-41` — add `operatorIdentities` to `EngineState`
- Modify: `core/server.ts` — populate identities after adapter connect, use in stream endpoint
- Test: `tests/server/stream-api.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/server/stream-api.test.ts`, add a test that verifies the stream API response includes `nextAction`:

```typescript
  it("includes nextAction in stream response", () => {
    graph.upsertWorkItem({
      id: "AI-300", source: "jira", title: "Blocked task",
      currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
    });
    graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-300" });
    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-300", agentId: "a1",
      status: "blocked_on_human", confidence: 0.9, reason: "Needs approval",
      rawText: "Please approve", timestamp: new Date().toISOString(),
      targetedAtOperator: true,
      actionRequiredFrom: ["U_OPERATOR"],
      nextAction: "Approve PR #716",
    });

    // Make request to stream endpoint
    const res = await app.request("/api/work-item/AI-300/stream");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nextAction).toBe("Approve PR #716");
  });
```

Note: Check the existing test file's setup pattern (how `app` and `graph` are initialized) and follow the same pattern. The test may need `async` and the correct `app` variable from the test file's `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: FAIL — `nextAction` is not in the response

- [ ] **Step 3: Add operatorIdentities to EngineState**

In `core/server.ts`, add the import for `OperatorIdentityMap`:

```typescript
import type { OperatorIdentityMap } from "./types.js";
```

In the `EngineState` interface (around line 27-41), add:

```typescript
  operatorIdentities: OperatorIdentityMap;
```

- [ ] **Step 4: Initialize operatorIdentities where EngineState is created**

Search for where `EngineState` is constructed in `core/server.ts` (likely in a `createEngineState` or inline object). Add:

```typescript
  operatorIdentities: new Map(),
```

- [ ] **Step 5: Populate identities after adapter connects**

Find the messaging adapter connect handler in `core/server.ts`. After `state.messagingAdapter = adapter` (or equivalent), add:

```typescript
    // Collect operator identity from messaging adapter
    const msgIdentity = state.messagingAdapter?.getAuthenticatedUser?.();
    if (msgIdentity) {
      state.operatorIdentities.set(state.messagingAdapter!.name, msgIdentity);
    }
```

Find the task adapter connect handler. After `state.taskAdapter = adapter`, add:

```typescript
    // Collect operator identity from task adapter
    const taskIdentity = state.taskAdapter?.getAuthenticatedUser?.();
    if (taskIdentity) {
      state.operatorIdentities.set(state.taskAdapter!.name, taskIdentity);
    }
```

Also update the config reload path (around line 951) to refresh identities.

- [ ] **Step 6: Update the stream endpoint to pass identities and include nextAction**

In the `GET /api/work-item/:id/stream` handler (around line 191), update the `buildUnifiedStatus` call and response:

```typescript
    const unifiedStatus = buildUnifiedStatus(workItem, latestBlockEvent, state.operatorIdentities, agentMap);
```

And add `nextAction` to the JSON response (around line 210-222):

```typescript
    return c.json({
      workItem,
      unifiedStatus,
      statusSummary,
      agents: agents.map((a) => ({ id: a.id, name: a.name, avatarUrl: a.avatarUrl })),
      channels: channels.map((ch) => ({ id: ch.id, name: ch.name })),
      threadCount: threads.length,
      enrichment: enrichments[0] ?? null,
      timeline,
      latestThreadId: latestThread?.id ?? null,
      latestChannelId: latestThread?.channelId ?? null,
      targetedAtOperator: latestEventForTarget?.targetedAtOperator ?? true,
      nextAction: latestBlockEvent?.nextAction ?? null,
    });
```

Note: `buildUnifiedStatus` won't compile yet with the new signature — that's Task 4. For now, make the server pass the new args and the test will validate the `nextAction` field in the response. You may need to temporarily adjust the `buildUnifiedStatus` signature to accept the new args (add them as optional params that are ignored) to keep compilation working.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: PASS — response includes `nextAction`

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add core/server.ts tests/server/stream-api.test.ts
git commit -m "feat: collect operator identities from adapters and include nextAction in stream API"
```

---

### Task 4: Update buildUnifiedStatus() with Actor-Aware Labels

Update `buildUnifiedStatus()` to resolve actor names from `actionRequiredFrom` and check operator identities.

**Files:**
- Modify: `core/stream.ts:30-65` — new signature and actor resolution logic
- Modify: `core/stream.ts:17-28` — add `nextAction` to `StreamData`
- Test: `tests/server/stream-api.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/server/stream-api.test.ts`, add these tests in the `buildUnifiedStatus` describe block:

```typescript
  describe("buildUnifiedStatus actor-aware labels", () => {
    it("shows 'Waiting on you' when operator is in actionRequiredFrom", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs approval", rawText: "Please approve",
        timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: ["U_OPERATOR"],
        nextAction: "Approve PR #716",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["a1", "Byte"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on you · \d+m/);
    });

    it("shows actor name when someone else is in actionRequiredFrom", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs Guy's review", rawText: "Waiting for Guy",
        timestamp: new Date(Date.now() - 130 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_GUY123"],
        nextAction: "Review PR #716",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["U_GUY123", "Guy"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on Guy · 2h \d+m/);
    });

    it("shows 'Needs your decision' when operator is action taker for needs_decision", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "needs_decision", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "needs_decision", confidence: 0.9,
        reason: "Choose palette", rawText: "Pick a color",
        timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: ["U_OPERATOR"],
        nextAction: "Choose between 3 palette options",
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Needs your decision · \d+m/);
    });

    it("shows actor name for needs_decision when someone else", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "needs_decision", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "needs_decision", confidence: 0.9,
        reason: "Guy needs to decide", rawText: "Decision needed",
        timestamp: new Date(Date.now() - 90 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_GUY123"],
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map([["U_GUY123", "Guy"]]);
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Needs Guy's decision · 1h \d+m/);
    });

    it("falls back to hardcoded labels when actionRequiredFrom is null", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs approval", rawText: "Please approve",
        timestamp: new Date(Date.now() - 5 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: true,
        actionRequiredFrom: null,
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map();
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on you · 5m/);
    });

    it("uses raw user ID when name cannot be resolved", () => {
      const workItem: WorkItem = {
        id: "AI-100", source: "jira", title: "Test",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "blocked_on_human", currentConfidence: 0.9,
        snoozedUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const blockEvent: Event = {
        id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
        agentId: "a1", status: "blocked_on_human", confidence: 0.9,
        reason: "Needs review", rawText: "Please review",
        timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
        createdAt: new Date().toISOString(), entryType: "block",
        targetedAtOperator: false,
        actionRequiredFrom: ["U_UNKNOWN"],
        nextAction: null,
      };
      const operatorIdentities: OperatorIdentityMap = new Map([
        ["slack", { userId: "U_OPERATOR", userName: "Nir" }],
      ]);
      const agentMap = new Map<string, string>();
      const result = buildUnifiedStatus(workItem, blockEvent, operatorIdentities, agentMap);
      expect(result).toMatch(/Waiting on U_UNKNOWN · \d+m/);
    });
  });
```

Add the import at the top of the test file:

```typescript
import type { OperatorIdentityMap } from "../../core/types.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: FAIL — `buildUnifiedStatus` doesn't accept the new parameters

- [ ] **Step 3: Implement the updated buildUnifiedStatus**

Replace the `buildUnifiedStatus` function in `core/stream.ts` (lines 30-65):

```typescript
import type { EntryType, OperatorIdentityMap, StatusCategory, Event, WorkItem, Agent, Enrichment } from "./types.js";

export function buildUnifiedStatus(
  workItem: WorkItem,
  latestBlockEvent: Event | null,
  operatorIdentities?: OperatorIdentityMap,
  agentNameMap?: Map<string, string>,
): string {
  if (!workItem.currentAtcStatus) return "Unknown";

  const status = workItem.currentAtcStatus;

  // Resolve the actor-aware label for blocked/decision statuses
  let label: string;

  if (
    latestBlockEvent &&
    (status === "blocked_on_human" || status === "needs_decision") &&
    latestBlockEvent.actionRequiredFrom &&
    latestBlockEvent.actionRequiredFrom.length > 0 &&
    operatorIdentities
  ) {
    // Check if operator is in actionRequiredFrom
    const isOperator = [...operatorIdentities.values()].some(
      (identity) => latestBlockEvent.actionRequiredFrom!.includes(identity.userId),
    );

    if (isOperator) {
      label = status === "needs_decision" ? "Needs your decision" : "Waiting on you";
    } else {
      // Resolve first action taker to a display name
      const firstActorId = latestBlockEvent.actionRequiredFrom[0];
      const actorName = agentNameMap?.get(firstActorId) ?? firstActorId;
      label = status === "needs_decision"
        ? `Needs ${actorName}'s decision`
        : `Waiting on ${actorName}`;
    }
  } else {
    // Fallback to hardcoded labels (backwards-compatible)
    const statusLabels: Record<string, string> = {
      blocked_on_human: "Waiting on you",
      needs_decision: "Needs your decision",
      in_progress: "In progress",
      completed: "Completed",
      noise: "No action needed",
    };
    label = statusLabels[status] ?? status;
  }

  // Append waiting time for blocked/decision statuses
  if (
    latestBlockEvent &&
    (status === "blocked_on_human" || status === "needs_decision")
  ) {
    const blockTime = new Date(latestBlockEvent.timestamp);
    const now = new Date();
    const diffMs = now.getTime() - blockTime.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${label} · ${diffMins}m`;
    }
    const diffHours = Math.floor(diffMins / 60);
    const remainMins = diffMins % 60;
    return `${label} · ${diffHours}h ${remainMins}m`;
  }

  return label;
}
```

- [ ] **Step 4: Add nextAction to StreamData**

In `core/stream.ts`, add to the `StreamData` interface (after `latestChannelId`):

```typescript
  nextAction: string | null;
```

- [ ] **Step 5: Update existing tests to use new signature**

The existing `buildUnifiedStatus` tests in `tests/server/stream-api.test.ts` call `buildUnifiedStatus(workItem, blockEvent)` with 2 args. These will still work because the new params are optional. However, the `Event` objects in those tests don't have `actionRequiredFrom` and `nextAction`. Add these fields (set to `null`) to each Event literal in existing tests:

```typescript
        actionRequiredFrom: null,
        nextAction: null,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: PASS — all old and new tests pass

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass. Other test files that create Event objects may need the new fields added — check for type errors.

- [ ] **Step 8: Commit**

```bash
git add core/stream.ts tests/server/stream-api.test.ts
git commit -m "feat: actor-aware status labels in buildUnifiedStatus"
```

---

### Task 5: Thread actionRequiredFrom and nextAction Through Pipeline

Pass the classifier's `actionRequiredFrom` and `nextAction` through all `insertEvent()` calls in the pipeline.

**Files:**
- Modify: `core/pipeline.ts:250-260` — completed-skip path
- Modify: `core/pipeline.ts:283-294` — dedup path
- Modify: `core/pipeline.ts:373-385` — main event insertion
- Modify: `core/pipeline.ts:420-432` — breakdown event insertion
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/core/pipeline.test.ts`, add a test that verifies actionRequiredFrom and nextAction are persisted through the pipeline:

```typescript
  it("persists actionRequiredFrom and nextAction from classification", async () => {
    const classification: Classification = {
      status: "blocked_on_human",
      entryType: "block",
      confidence: 0.9,
      reason: "Needs Guy's review",
      workItemIds: [],
      title: "PR review needed",
      targetedAtOperator: false,
      actionRequiredFrom: ["U_GUY123"],
      nextAction: "Review and approve PR #716",
    };

    mockClassifier.classify.mockResolvedValue(classification);

    const message: Message = {
      id: "msg-action-1",
      threadId: "thread-action-1",
      channelId: "C1",
      channelName: "test",
      userId: "U1",
      userName: "Byte",
      text: "Waiting for Guy to review PR #716",
      timestamp: new Date().toISOString(),
      platform: "slack",
    };

    await pipeline.processMessage(message, "thread-action-1", "C1");

    const events = graph.getEventsForWorkItem(`thread:thread-action-1`);
    const mainEvent = events.find((e) => e.messageId === "msg-action-1");
    expect(mainEvent).toBeDefined();
    expect(mainEvent!.actionRequiredFrom).toEqual(["U_GUY123"]);
    expect(mainEvent!.nextAction).toBe("Review and approve PR #716");
  });
```

Note: Check the existing test file's imports and mock setup patterns. The test file likely already has `mockClassifier`, `pipeline`, `graph` etc. set up in `beforeEach`. Follow the existing patterns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/pipeline.test.ts --reporter=verbose`
Expected: FAIL — `actionRequiredFrom` is null because pipeline doesn't pass it to insertEvent

- [ ] **Step 3: Update main event insertion**

In `core/pipeline.ts`, update the Step 5 `insertEvent()` call (around line 373-385):

```typescript
    this.graph.insertEvent({
      threadId: thread.id,
      messageId: message.id,
      workItemId: primaryWorkItemId,
      agentId: agent.id,
      status: classification.status,
      entryType: classification.entryType,
      confidence: classification.confidence,
      reason: classification.reason,
      rawText: message.text,
      timestamp: message.timestamp,
      targetedAtOperator: classification.targetedAtOperator,
      actionRequiredFrom: classification.actionRequiredFrom,
      nextAction: classification.nextAction,
    });
```

- [ ] **Step 4: Update breakdown event insertion**

In `core/pipeline.ts`, update the breakdown insertEvent call (around line 420-432):

```typescript
          this.graph.insertEvent({
            threadId: thread.id,
            messageId: `${message.id}:${workItemId}`,
            workItemId,
            agentId: agent.id,
            status: itemClassification.status,
            entryType: itemClassification.entryType,
            confidence: itemClassification.confidence,
            reason: itemClassification.reason,
            rawText: message.text,
            timestamp: message.timestamp,
            targetedAtOperator: itemClassification.targetedAtOperator,
            actionRequiredFrom: itemClassification.actionRequiredFrom,
            nextAction: itemClassification.nextAction,
          });
```

- [ ] **Step 5: Update completed-skip and dedup paths**

The completed-skip path (around line 250-260) and dedup path (around line 283-294) don't have classification data — they should pass `null` explicitly (which is already the default, but be explicit for clarity):

In the completed-skip `insertEvent` (line 250):
```typescript
        this.graph.insertEvent({
          threadId: thread.id,
          messageId: message.id,
          workItemId: inheritedWorkItemId,
          agentId: message.userId,
          status: "noise",
          confidence: 0,
          reason: "Work item already completed — skipping classification",
          rawText: message.text,
          timestamp: message.timestamp,
          actionRequiredFrom: null,
          nextAction: null,
        });
```

In the dedup `insertEvent` (line 283):
```typescript
        this.graph.insertEvent({
          threadId: thread.id,
          messageId: message.id,
          workItemId: inheritedWorkItemId,
          agentId: message.userId,
          status: cachedResult.status,
          confidence: cachedResult.confidence,
          reason: cachedResult.reason + " (deduplicated)",
          rawText: message.text,
          timestamp: message.timestamp,
          actionRequiredFrom: cachedResult.actionRequiredFrom,
          nextAction: cachedResult.nextAction,
        });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/pipeline.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add core/pipeline.ts tests/core/pipeline.test.ts
git commit -m "feat: thread actionRequiredFrom and nextAction through pipeline insertEvent calls"
```

---

### Task 6: Update UI to Show nextAction

Add `nextAction` to the frontend `StreamData` type and render it in `StatusSnapshot.tsx`.

**Files:**
- Modify: `src/lib/api.ts:362-373` — add `nextAction` to `StreamData`
- Modify: `src/components/stream/StatusSnapshot.tsx:25-44` — render next action line

- [ ] **Step 1: Add nextAction to frontend StreamData**

In `src/lib/api.ts`, add to the `StreamData` interface (after `latestChannelId` on line 372):

```typescript
  nextAction: string | null;
```

- [ ] **Step 2: Render nextAction in StatusSnapshot**

In `src/components/stream/StatusSnapshot.tsx`, after the status badge div (after line 44, after the closing `</div>` of the badge), add:

```tsx
      {data.nextAction && (
        <p className="text-xs text-gray-400 mt-1 pl-0.5">{data.nextAction}</p>
      )}
```

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/components/stream/StatusSnapshot.tsx
git commit -m "feat: render nextAction line in Fleet view detail pane"
```
