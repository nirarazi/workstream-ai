# Work Item Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat work item display with a layered Work Item Stream (status snapshot, timeline, excerpts, suggested actions) and fix the critical graph gaps that prevent it from working.

**Architecture:** Backend-first approach. Add `entry_type` column to events, capture operator replies as decision events, build a new `/api/work-item/:id/stream` endpoint that aggregates multi-thread/multi-agent data, then build the frontend WorkItemStream component that replaces ContextPane's content.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, React + Tailwind CSS, Hono HTTP server

---

### Task 1: Add `entry_type` column to events table

**Files:**
- Modify: `core/graph/db.ts` (migration)
- Modify: `core/graph/schema.ts` (EventRow type)
- Modify: `core/types.ts` (Event type + EntryType)
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/graph/db.test.ts`:

```typescript
it("has entry_type column on events table", () => {
  const cols = db.db.pragma("table_info(events)") as Array<{ name: string }>;
  expect(cols.some((c) => c.name === "entry_type")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/graph/db.test.ts --reporter=verbose`
Expected: FAIL — "entry_type" column does not exist

- [ ] **Step 3: Add EntryType to core/types.ts**

Add after the `StatusCategory` type:

```typescript
export type EntryType =
  | "block"
  | "decision"
  | "progress"
  | "assignment"
  | "escalation"
  | "noise";
```

Add `entryType` field to the `Event` interface:

```typescript
export interface Event {
  id: string;
  threadId: string;
  messageId: string;
  workItemId: string | null;
  agentId: string | null;
  status: StatusCategory;
  confidence: number;
  reason: string;
  rawText: string;
  timestamp: string;
  createdAt: string;
  entryType: EntryType;
}
```

- [ ] **Step 4: Add entry_type to EventRow in core/graph/schema.ts**

```typescript
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
}
```

- [ ] **Step 5: Add migration in core/graph/db.ts**

Add at the end of the `migrate()` method:

```typescript
// Add entry_type column to events table
const eventCols = this.db.pragma("table_info(events)") as Array<{ name: string }>;
if (!eventCols.some((c) => c.name === "entry_type")) {
  this.db.exec("ALTER TABLE events ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'progress'");
  // Backfill: blocked_on_human/needs_decision → block, completed → progress, noise → noise
  this.db.exec(`
    UPDATE events SET entry_type = CASE
      WHEN status IN ('blocked_on_human', 'needs_decision') THEN 'block'
      WHEN status = 'noise' THEN 'noise'
      ELSE 'progress'
    END
  `);
  log.info("Migration: added entry_type column to events and backfilled");
}
```

- [ ] **Step 6: Update toEvent mapper in core/graph/index.ts**

```typescript
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
    entryType: (row.entry_type as EntryType) ?? "progress",
  };
}
```

- [ ] **Step 7: Update insertEvent in core/graph/index.ts**

Modify the `insertEvent` method to accept and store `entryType`:

Update the method signature's parameter type to include:
```typescript
entryType?: EntryType;
```

Update the SQL INSERT to include `entry_type` column:
```sql
INSERT OR IGNORE INTO events (id, thread_id, message_id, work_item_id, agent_id, status, confidence, reason, raw_text, timestamp, created_at, entry_type)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

Pass `event.entryType ?? "progress"` as the last parameter.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/graph/db.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 9: Run full test suite to check for breakage**

Run: `cd ~/Code/workstream-ai && npx vitest run --reporter=verbose`
Expected: All existing tests pass. Some tests may need `entryType` added to expected Event objects — fix any that fail by adding `entryType: "progress"` (or using `expect.objectContaining`).

- [ ] **Step 10: Commit**

```bash
cd ~/Code/workstream-ai
git add core/types.ts core/graph/schema.ts core/graph/db.ts core/graph/index.ts tests/graph/db.test.ts
git commit -m "feat: add entry_type column to events for timeline typing"
```

---

### Task 2: Capture operator replies as decision events

**Files:**
- Modify: `core/server.ts` (reply and action endpoints)
- Modify: `core/actions.ts` (insert event after action)
- Test: `tests/actions/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/actions/actions.test.ts`:

```typescript
describe("operator event capture", () => {
  it("inserts a decision event when operator approves", async () => {
    seedWorkItem();
    seedThread();
    const adapter = createMockAdapter();
    const handler = new ActionHandler(graph, adapter);

    await handler.execute("AI-100", "approve", "Looks good");

    const events = graph.getEventsForWorkItem("AI-100");
    const decisionEvent = events.find((e) => e.entryType === "decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.status).toBe("completed");
    expect(decisionEvent!.rawText).toContain("Looks good");
    expect(decisionEvent!.agentId).toBeNull();
  });

  it("inserts a decision event when operator redirects with message", async () => {
    seedWorkItem();
    seedThread();
    const adapter = createMockAdapter();
    const handler = new ActionHandler(graph, adapter);

    await handler.execute("AI-100", "redirect", "Please fix the tests first");

    const events = graph.getEventsForWorkItem("AI-100");
    const decisionEvent = events.find((e) => e.entryType === "decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.rawText).toContain("Please fix the tests first");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/actions/actions.test.ts --reporter=verbose`
Expected: FAIL — no decision events found

- [ ] **Step 3: Add operator event insertion to ActionHandler**

In `core/actions.ts`, add a private method:

```typescript
private insertOperatorEvent(
  workItemId: string,
  action: ActionType,
  message?: string,
): void {
  const threads = this.graph.getThreadsForWorkItem(workItemId);
  const thread = threads[0];
  if (!thread) return;

  const statusMap: Record<ActionType, StatusCategory> = {
    approve: "completed",
    close: "completed",
    redirect: "in_progress",
    snooze: "in_progress",
  };

  this.graph.insertEvent({
    threadId: thread.id,
    messageId: `operator-${action}-${Date.now()}`,
    workItemId,
    agentId: null,
    status: statusMap[action],
    confidence: 1.0,
    reason: `Operator ${action}`,
    rawText: message ?? "",
    timestamp: new Date().toISOString(),
    entryType: "decision",
  });
}
```

Add the import at the top of `core/actions.ts`:

```typescript
import type { StatusCategory, EntryType } from "./types.js";
```

- [ ] **Step 4: Call insertOperatorEvent from each action handler**

In `handleApprove`, add after `sendThreadMessage` and before `upsertWorkItem`:

```typescript
this.insertOperatorEvent(workItemId, "approve", message);
```

In `handleRedirect`, add after `sendThreadMessage`:

```typescript
this.insertOperatorEvent(workItemId, "redirect", message);
```

In `handleClose`, add after `sendThreadMessage`:

```typescript
this.insertOperatorEvent(workItemId, "close", message);
```

In `handleSnooze`, add at the beginning of the method:

```typescript
this.insertOperatorEvent(workItemId, "snooze");
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/actions/actions.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Also capture free-text replies as decision events**

In `core/server.ts`, find the `POST /api/reply` handler. After the successful `replyToThread` call (around line 284), add event insertion:

```typescript
// Capture operator reply as a decision event
if (body.workItemId) {
  const threads = state.graph.getThreadsForWorkItem(body.workItemId);
  const thread = threads.find((t) => t.id === body.threadId);
  if (thread) {
    state.graph.insertEvent({
      threadId: body.threadId!,
      messageId: `operator-reply-${Date.now()}`,
      workItemId: body.workItemId,
      agentId: null,
      status: "in_progress",
      confidence: 1.0,
      reason: "Operator reply",
      rawText: body.message,
      timestamp: new Date().toISOString(),
      entryType: "decision",
    });
  }
}
```

Note: The reply endpoint needs the `workItemId` passed from the frontend. Check if it's already in the request body — if not, the frontend will need to include it (handled in Task 6).

- [ ] **Step 7: Commit**

```bash
cd ~/Code/workstream-ai
git add core/actions.ts core/server.ts tests/actions/actions.test.ts
git commit -m "feat: capture operator actions and replies as decision events"
```

---

### Task 3: Build the Stream API endpoint

**Files:**
- Create: `core/stream.ts`
- Modify: `core/server.ts` (new endpoint)
- Modify: `core/graph/index.ts` (new query methods)
- Test: `tests/server/stream-api.test.ts`

- [ ] **Step 1: Define the StreamItem types**

Create `core/stream.ts`:

```typescript
// core/stream.ts — Work Item Stream: aggregated view for the operator

import type { EntryType, StatusCategory, Event, WorkItem, Agent, Enrichment } from "./types.js";

export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: StatusCategory;
  timestamp: string;
  agentName: string | null;
  channelName: string;
  summary: string;           // The "reason" field, or a generated one-liner
  rawText: string;
  isOperator: boolean;        // true if agentId is null (operator action)
}

export interface StreamData {
  // Status Snapshot
  workItem: WorkItem;
  unifiedStatus: string;                // "Waiting on you · 2h 14m"
  statusSummary: string | null;         // One-sentence explanation of why it's surfacing
  agents: Array<{ id: string; name: string; avatarUrl: string | null }>;
  channels: Array<{ id: string; name: string }>;
  threadCount: number;
  enrichment: Enrichment | null;        // Latest task adapter enrichment

  // Timeline
  timeline: TimelineEntry[];

  // Actions
  quickReplies: string[];
}

export function buildUnifiedStatus(
  workItem: WorkItem,
  latestBlockEvent: Event | null,
): string {
  if (!workItem.currentAtcStatus) return "Unknown";

  const statusLabels: Record<string, string> = {
    blocked_on_human: "Waiting on you",
    needs_decision: "Needs your decision",
    in_progress: "In progress",
    completed: "Completed",
    noise: "No action needed",
  };

  const label = statusLabels[workItem.currentAtcStatus] ?? workItem.currentAtcStatus;

  if (
    latestBlockEvent &&
    (workItem.currentAtcStatus === "blocked_on_human" ||
      workItem.currentAtcStatus === "needs_decision")
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

export function buildTimeline(
  events: Event[],
  agentMap: Map<string, string>,
  threadChannelMap: Map<string, string>,
): TimelineEntry[] {
  return events
    .filter((e) => e.entryType !== "noise")
    .map((e) => ({
      id: e.id,
      entryType: e.entryType,
      status: e.status,
      timestamp: e.timestamp,
      agentName: e.agentId ? (agentMap.get(e.agentId) ?? null) : null,
      channelName: threadChannelMap.get(e.threadId) ?? "",
      summary: e.reason,
      rawText: e.rawText,
      isOperator: e.agentId === null,
    }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
```

- [ ] **Step 2: Write the failing test for the stream endpoint**

Create `tests/server/stream-api.test.ts`:

```typescript
// tests/server/stream-api.test.ts — Stream endpoint tests

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { buildUnifiedStatus, buildTimeline } from "../../core/stream.js";
import type { Event, WorkItem } from "../../core/types.js";

describe("Stream", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("buildUnifiedStatus", () => {
    it("shows waiting time for blocked items", () => {
      const workItem: WorkItem = {
        id: "AI-100",
        source: "jira",
        title: "Test",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: "blocked_on_human",
        currentConfidence: 0.9,
        snoozedUntil: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const blockEvent: Event = {
        id: "e1",
        threadId: "t1",
        messageId: "m1",
        workItemId: "AI-100",
        agentId: "a1",
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "Needs approval",
        rawText: "Please approve",
        timestamp: new Date(Date.now() - 130 * 60000).toISOString(), // 2h 10m ago
        createdAt: new Date().toISOString(),
        entryType: "block",
      };

      const result = buildUnifiedStatus(workItem, blockEvent);
      expect(result).toMatch(/Waiting on you · 2h \d+m/);
    });

    it("shows label without time for in_progress items", () => {
      const workItem: WorkItem = {
        id: "AI-100",
        source: "jira",
        title: "Test",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: "in_progress",
        currentConfidence: 0.9,
        snoozedUntil: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = buildUnifiedStatus(workItem, null);
      expect(result).toBe("In progress");
    });
  });

  describe("buildTimeline", () => {
    it("filters noise and sorts newest first", () => {
      const events: Event[] = [
        {
          id: "e1", threadId: "t1", messageId: "m1", workItemId: "AI-100",
          agentId: "a1", status: "in_progress", confidence: 0.9,
          reason: "Started work", rawText: "Starting", timestamp: "2026-04-15T10:00:00Z",
          createdAt: "2026-04-15T10:00:00Z", entryType: "progress",
        },
        {
          id: "e2", threadId: "t1", messageId: "m2", workItemId: "AI-100",
          agentId: "a1", status: "noise", confidence: 0.8,
          reason: "Status update", rawText: "Still working", timestamp: "2026-04-15T11:00:00Z",
          createdAt: "2026-04-15T11:00:00Z", entryType: "noise",
        },
        {
          id: "e3", threadId: "t2", messageId: "m3", workItemId: "AI-100",
          agentId: null, status: "completed", confidence: 1.0,
          reason: "Operator approved", rawText: "Looks good", timestamp: "2026-04-15T12:00:00Z",
          createdAt: "2026-04-15T12:00:00Z", entryType: "decision",
        },
      ];

      const agentMap = new Map([["a1", "Byte"]]);
      const threadChannelMap = new Map([["t1", "#agent-orchestrator"], ["t2", "#strategy"]]);

      const timeline = buildTimeline(events, agentMap, threadChannelMap);

      expect(timeline).toHaveLength(2); // noise filtered out
      expect(timeline[0].entryType).toBe("decision"); // newest first
      expect(timeline[0].isOperator).toBe(true);
      expect(timeline[0].channelName).toBe("#strategy");
      expect(timeline[1].entryType).toBe("progress");
      expect(timeline[1].agentName).toBe("Byte");
    });
  });

  describe("multi-agent multi-thread aggregation", () => {
    it("getAgentsForWorkItem returns all agents who have events", () => {
      graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Test" });
      graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-100" });
      graph.upsertThread({ id: "t2", channelId: "C2", channelName: "strategy", platform: "slack", workItemId: "AI-100" });

      const agent1 = graph.upsertAgent({ name: "Byte", platform: "slack", platformUserId: "U1" });
      const agent2 = graph.upsertAgent({ name: "Pixel", platform: "slack", platformUserId: "U2" });

      graph.insertEvent({ threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: agent1.id, status: "in_progress", confidence: 0.9, timestamp: new Date().toISOString(), entryType: "progress" });
      graph.insertEvent({ threadId: "t2", messageId: "m2", workItemId: "AI-100", agentId: agent2.id, status: "blocked_on_human", confidence: 0.9, timestamp: new Date().toISOString(), entryType: "block" });

      const agents = graph.getAgentsForWorkItem("AI-100");
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name).sort()).toEqual(["Byte", "Pixel"]);
    });

    it("getChannelsForWorkItem returns all channels", () => {
      graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Test" });
      graph.upsertThread({ id: "t1", channelId: "C1", channelName: "orchestrator", platform: "slack", workItemId: "AI-100" });
      graph.upsertThread({ id: "t2", channelId: "C2", channelName: "strategy", platform: "slack", workItemId: "AI-100" });

      const channels = graph.getChannelsForWorkItem("AI-100");
      expect(channels).toHaveLength(2);
      expect(channels.map((c) => c.name).sort()).toEqual(["orchestrator", "strategy"]);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: FAIL — `getAgentsForWorkItem` and `getChannelsForWorkItem` don't exist

- [ ] **Step 4: Add aggregation query methods to ContextGraph**

Add to `core/graph/index.ts`:

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/Code/workstream-ai && npx vitest run tests/server/stream-api.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Add the stream endpoint to core/server.ts**

Add after the existing `/api/work-item/:id/context` endpoint:

```typescript
// --- GET /api/work-item/:id/stream ---
app.get("/api/work-item/:id/stream", async (c) => {
  const id = c.req.param("id");
  const workItem = state.graph.getWorkItemById(id);
  if (!workItem) {
    return c.json({ error: "Work item not found" }, 404);
  }

  const threads = state.graph.getThreadsForWorkItem(id);
  const events = state.graph.getEventsForWorkItem(id);
  const agents = state.graph.getAgentsForWorkItem(id);
  const channels = state.graph.getChannelsForWorkItem(id);
  const enrichments = state.graph.getEnrichmentsForWorkItem(id);

  // Build agent name map for timeline
  const agentMap = new Map<string, string>();
  for (const a of agents) {
    agentMap.set(a.id, a.name);
  }

  // Build thread → channel name map
  const threadChannelMap = new Map<string, string>();
  for (const t of threads) {
    threadChannelMap.set(t.id, t.channelName || t.channelId);
  }

  // Find latest block event for status duration
  const latestBlockEvent = events
    .filter((e) => e.status === "blocked_on_human" || e.status === "needs_decision")
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] ?? null;

  const { buildUnifiedStatus, buildTimeline } = await import("./stream.js");

  const unifiedStatus = buildUnifiedStatus(workItem, latestBlockEvent);
  const timeline = buildTimeline(events, agentMap, threadChannelMap);

  // Summary: use cached if fresh
  let statusSummary: string | null = null;
  const cached = state.graph.getSummary(id);
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  if (cached && latestEvent && cached.latestEventId === latestEvent.id) {
    statusSummary = cached.summaryText;
  }

  const quickReplies: string[] =
    (state.config as any).quickReplies?.[workItem.currentAtcStatus ?? ""] ?? [];

  return c.json({
    workItem,
    unifiedStatus,
    statusSummary,
    agents: agents.map((a) => ({ id: a.id, name: a.name, avatarUrl: a.avatarUrl })),
    channels: channels.map((ch) => ({ id: ch.id, name: ch.name })),
    threadCount: threads.length,
    enrichment: enrichments[0] ?? null,
    timeline,
    quickReplies,
  });
});
```

- [ ] **Step 7: Commit**

```bash
cd ~/Code/workstream-ai
git add core/stream.ts core/graph/index.ts core/server.ts tests/server/stream-api.test.ts
git commit -m "feat: add stream API endpoint with timeline and aggregation"
```

---

### Task 4: Set entry_type from classifier

**Files:**
- Modify: `core/classifier/index.ts` (parse entry_type from response)
- Modify: `core/types.ts` (add entryType to Classification)
- Modify: `core/pipeline.ts` (pass entryType to insertEvent)
- Modify: `config/prompts/classify.yaml` (add entry_type to prompt)
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Add entryType to Classification type**

In `core/types.ts`, add to the `Classification` interface:

```typescript
export interface Classification {
  status: StatusCategory;
  confidence: number;
  reason: string;
  workItemIds: string[];
  title: string;
  breakdown?: ClassificationBreakdown[];
  entryType: EntryType;
}
```

Also add `entryType` to `ClassificationBreakdown`:

```typescript
export interface ClassificationBreakdown {
  workItemId: string;
  status: StatusCategory;
  confidence: number;
  reason: string;
  title: string;
  entryType: EntryType;
}
```

- [ ] **Step 2: Update classifier to parse entryType from LLM response**

In `core/classifier/index.ts`, find where the LLM JSON response is parsed into a `Classification` object. Add `entryType` parsing with a fallback:

```typescript
// After parsing the LLM response JSON:
const entryType = parsed.entry_type ?? inferEntryType(parsed.status);
```

Add the fallback function:

```typescript
function inferEntryType(status: StatusCategory): EntryType {
  switch (status) {
    case "blocked_on_human":
    case "needs_decision":
      return "block";
    case "noise":
      return "noise";
    default:
      return "progress";
  }
}
```

Include `entryType` in the returned `Classification` object.

- [ ] **Step 3: Update the classifier prompt**

In `config/prompts/classify.yaml`, add `entry_type` to the expected JSON output format. Add to the system prompt section that describes the output format:

```
- "entry_type": one of "block", "progress", "assignment", "escalation", "noise"
  - "block": agent is waiting for the operator's input, approval, or action
  - "progress": agent completed a step or is actively working
  - "assignment": work was assigned, reassigned, or handed off to a different agent
  - "escalation": agent flagged a problem, error, or exception
  - "noise": informational status update, no action needed
```

- [ ] **Step 4: Update pipeline to pass entryType when inserting events**

In `core/pipeline.ts`, find where `graph.insertEvent` is called. Add `entryType` from the classification:

```typescript
graph.insertEvent({
  // ...existing fields...
  entryType: classification.entryType,
});
```

Do the same for breakdown events:

```typescript
graph.insertEvent({
  // ...existing fields...
  entryType: item.entryType,
});
```

- [ ] **Step 5: Fix any failing tests**

Run: `cd ~/Code/workstream-ai && npx vitest run --reporter=verbose`

Update test helpers (like `makeClassification()` in `tests/core/pipeline.test.ts`) to include `entryType: "progress"` in the default classification object. Update any test assertions that check the full Classification shape.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/workstream-ai
git add core/types.ts core/classifier/index.ts core/pipeline.ts config/prompts/classify.yaml tests/core/pipeline.test.ts
git commit -m "feat: classifier returns entry_type for timeline categorization"
```

---

### Task 5: Add fetchStream to the frontend API client

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the StreamData types and fetch function**

Add to `src/lib/api.ts`:

```typescript
export type EntryType = "block" | "decision" | "progress" | "assignment" | "escalation" | "noise";

export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: string;
  timestamp: string;
  agentName: string | null;
  channelName: string;
  summary: string;
  rawText: string;
  isOperator: boolean;
}

export interface StreamData {
  workItem: WorkItem;
  unifiedStatus: string;
  statusSummary: string | null;
  agents: Array<{ id: string; name: string; avatarUrl: string | null }>;
  channels: Array<{ id: string; name: string }>;
  threadCount: number;
  enrichment: Enrichment | null;
  timeline: TimelineEntry[];
  quickReplies: string[];
}

export async function fetchStream(workItemId: string): Promise<StreamData> {
  const res = await fetch(`${BASE}/api/work-item/${encodeURIComponent(workItemId)}/stream`);
  if (!res.ok) throw new Error(`Stream fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/workstream-ai
git add src/lib/api.ts
git commit -m "feat: add fetchStream to frontend API client"
```

---

### Task 6: Build the WorkItemStream component

**Files:**
- Create: `src/components/WorkItemStream.tsx`
- Create: `src/components/stream/StatusSnapshot.tsx`
- Create: `src/components/stream/Timeline.tsx`
- Create: `src/components/stream/TimelineEntry.tsx`
- Create: `src/components/stream/SuggestedActions.tsx`

- [ ] **Step 1: Create StatusSnapshot component**

Create `src/components/stream/StatusSnapshot.tsx`:

```tsx
import type { StreamData } from "../../lib/api";

interface StatusSnapshotProps {
  data: StreamData;
}

export default function StatusSnapshot({ data }: StatusSnapshotProps) {
  const { workItem, unifiedStatus, statusSummary, agents, channels, threadCount, enrichment } = data;
  const isBlocked = workItem.currentAtcStatus === "blocked_on_human" || workItem.currentAtcStatus === "needs_decision";

  return (
    <div className="px-5 py-4 border-b border-gray-800">
      {/* ID */}
      {!workItem.id.startsWith("thread:") && (
        <div className="text-xs font-mono text-gray-500 mb-1">{workItem.id}</div>
      )}

      {/* Title */}
      <h2 className="text-lg font-semibold text-white mb-3">
        {workItem.title || workItem.id}
      </h2>

      {/* Unified status badge */}
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium mb-3 ${
        isBlocked
          ? "bg-red-500/15 text-red-400 border border-red-500/30"
          : "bg-gray-700/50 text-gray-300 border border-gray-700"
      }`}>
        {isBlocked && <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />}
        {unifiedStatus}
      </div>

      {/* Summary sentence */}
      {statusSummary && (
        <p className="text-sm text-gray-300 leading-relaxed mb-3">{statusSummary}</p>
      )}

      {/* Meta row */}
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        {agents.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
            {agents.map((a) => a.name).join(", ")}
          </span>
        )}
        {channels.length > 0 && (
          <span>
            {channels.map((c) => `#${c.name}`).join(", ")}
            {threadCount > 1 && ` · ${threadCount} threads`}
          </span>
        )}
        {enrichment && workItem.url && (
          <a
            href={workItem.url}
            onClick={(e) => { e.preventDefault(); window.open(workItem.url!); }}
            className="text-cyan-500 hover:text-cyan-400"
          >
            {enrichment.source}: {workItem.externalStatus ?? "View"} ↗
          </a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create TimelineEntry component**

Create `src/components/stream/TimelineEntry.tsx`:

```tsx
import { useState } from "react";
import { timeAgo } from "../../lib/time";
import type { TimelineEntry as TimelineEntryType } from "../../lib/api";

const ENTRY_ICONS: Record<string, string> = {
  block: "⏳",
  decision: "✅",
  progress: "🔨",
  assignment: "📋",
  escalation: "🚩",
};

interface TimelineEntryProps {
  entry: TimelineEntryType;
}

export default function TimelineEntryComponent({ entry }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div
        onClick={() => entry.rawText && setExpanded(!expanded)}
        className={`flex gap-2.5 py-1.5 rounded cursor-pointer hover:bg-white/[0.03] ${
          entry.entryType === "decision"
            ? "bg-cyan-500/[0.06] border-l-2 border-cyan-500 pl-2 -ml-2"
            : ""
        }`}
      >
        <span className="w-6 h-6 flex items-center justify-center text-sm flex-shrink-0">
          {ENTRY_ICONS[entry.entryType] ?? "·"}
        </span>
        <div className="flex-1 min-w-0">
          {entry.entryType === "decision" && (
            <div className="text-[10px] uppercase tracking-wider text-cyan-500 font-semibold mb-0.5">
              Your Decision
            </div>
          )}
          <div className="text-[13px] text-gray-300 leading-snug">{entry.summary}</div>
          <div className="text-[11px] text-gray-600 mt-0.5">
            {entry.channelName}
          </div>
        </div>
        <span className="text-[11px] text-gray-600 flex-shrink-0 pt-0.5">
          {timeAgo(entry.timestamp)}
        </span>
      </div>

      {/* Inline excerpt */}
      {expanded && entry.rawText && (
        <div className="ml-8 mt-1 mb-2 border-l-2 border-gray-800 pl-3">
          <div className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
            <span className={`font-medium ${entry.isOperator ? "text-purple-400" : "text-cyan-400"}`}>
              {entry.isOperator ? "You" : entry.agentName ?? "Agent"}
            </span>
            <span className="text-gray-600 ml-2 text-[11px]">
              {entry.channelName} · {timeAgo(entry.timestamp)}
            </span>
            <div className="mt-1 text-gray-400">{entry.rawText}</div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create Timeline component**

Create `src/components/stream/Timeline.tsx`:

```tsx
import { useState } from "react";
import type { TimelineEntry as TimelineEntryType } from "../../lib/api";
import TimelineEntryComponent from "./TimelineEntry";

interface TimelineProps {
  entries: TimelineEntryType[];
}

export default function Timeline({ entries }: TimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const decisionCount = entries.filter((e) => e.entryType === "decision").length;
  const oldestDate = entries.length > 0 ? entries[entries.length - 1].timestamp : "";
  const daySpan = oldestDate
    ? Math.ceil((Date.now() - new Date(oldestDate).getTime()) / 86400000)
    : 0;

  // Group by day
  const groups = new Map<string, TimelineEntryType[]>();
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label: string;
    if (date.toDateString() === today.toDateString()) {
      label = "Today";
    } else if (date.toDateString() === yesterday.toDateString()) {
      label = "Yesterday";
    } else {
      label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  return (
    <div className="border-b border-gray-800">
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] cursor-pointer"
      >
        <span className="text-[11px] uppercase tracking-widest text-gray-600">Timeline</span>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {daySpan > 0 && <span>📅 {daySpan}d</span>}
          {decisionCount > 0 && <span>✅ {decisionCount} decisions</span>}
          <span>💬 {entries.length} events</span>
          <span className={`text-[11px] text-gray-600 transition-transform ${expanded ? "rotate-180" : ""}`}>▼</span>
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <div className="px-5 pb-4">
          {Array.from(groups.entries()).map(([label, groupEntries]) => (
            <div key={label} className="mb-3">
              <div className="text-[11px] uppercase tracking-wider text-gray-600 mb-2 pb-1 border-b border-gray-800/50">
                {label}
              </div>
              {groupEntries.map((entry) => (
                <TimelineEntryComponent key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create SuggestedActions component**

Create `src/components/stream/SuggestedActions.tsx`:

```tsx
import { useState } from "react";
import type { StreamData } from "../../lib/api";
import { postAction, postReply } from "../../lib/api";

interface SuggestedActionsProps {
  data: StreamData;
  onActioned?: () => void;
}

export default function SuggestedActions({ data, onActioned }: SuggestedActionsProps) {
  const { workItem } = data;
  const [acting, setActing] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isBlocked = workItem.currentAtcStatus === "blocked_on_human" || workItem.currentAtcStatus === "needs_decision";
  if (!isBlocked) return null;

  async function handleAction(action: string, message?: string, duration?: number) {
    setActing(true);
    setError(null);
    try {
      await postAction(workItem.id, action, message, duration);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Suggested Actions</div>

      {/* Approve */}
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">✅ Approve</div>
        <div className="text-xs text-gray-600 mb-2">→ replies to latest thread</div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => handleAction("approve", "Approved. Go ahead.")}
            disabled={acting}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>

      {/* Request changes */}
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">✏️ Request changes</div>
        <div className="text-xs text-gray-600 mb-2">→ replies to latest thread</div>
        <input
          type="text"
          value={editMessage}
          onChange={(e) => setEditMessage(e.target.value)}
          placeholder="What changes do you need?"
          className="w-full bg-black/30 border border-gray-700 rounded-md px-2.5 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-cyan-600 mb-2"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => handleAction("redirect", editMessage)}
            disabled={acting || !editMessage.trim()}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>

      {/* Snooze */}
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-2">💤 Snooze</div>
        <div className="flex gap-1.5">
          {[
            { label: "1h", mins: 60 },
            { label: "4h", mins: 240 },
            { label: "Tomorrow", mins: 960 },
          ].map(({ label, mins }) => (
            <button
              key={label}
              onClick={() => handleAction("snooze", undefined, mins)}
              disabled={acting}
              className="px-3 py-1.5 rounded-md text-xs bg-white/[0.05] border border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Create the WorkItemStream container component**

Create `src/components/WorkItemStream.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchStream, type StreamData } from "../lib/api";
import StatusSnapshot from "./stream/StatusSnapshot";
import Timeline from "./stream/Timeline";
import SuggestedActions from "./stream/SuggestedActions";

interface WorkItemStreamProps {
  workItemId: string;
  onClose: () => void;
  onActioned?: () => void;
}

export default function WorkItemStream({
  workItemId,
  onClose,
  onActioned,
}: WorkItemStreamProps): JSX.Element {
  const [data, setData] = useState<StreamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStream(workItemId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [workItemId]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  function handleActioned() {
    // Refresh stream data
    fetchStream(workItemId)
      .then(setData)
      .catch(() => {});
    onActioned?.();
  }

  // Loading
  if (!data && !error) {
    return (
      <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6 overflow-y-auto animate-slide-in-right">
          <div className="flex items-center justify-between mb-6">
            <div className="h-5 w-32 bg-gray-800 rounded animate-pulse" />
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">&#x2715;</button>
          </div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-gray-900 rounded animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error
  if (error && !data) {
    return (
      <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6">
          <div className="flex items-center justify-between mb-6">
            <span className="text-sm text-red-400">{error}</span>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">&#x2715;</button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <></>;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
      <div
        ref={paneRef}
        className="w-full max-w-xl bg-gray-950 border-l border-gray-800 overflow-y-auto animate-slide-in-right"
      >
        {/* Close button */}
        <div className="absolute top-4 right-4 z-10">
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer text-lg">&#x2715;</button>
        </div>

        <StatusSnapshot data={data} />
        <Timeline entries={data.timeline} />
        <SuggestedActions data={data} onActioned={handleActioned} />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
cd ~/Code/workstream-ai
git add src/components/WorkItemStream.tsx src/components/stream/StatusSnapshot.tsx src/components/stream/Timeline.tsx src/components/stream/TimelineEntry.tsx src/components/stream/SuggestedActions.tsx
git commit -m "feat: add WorkItemStream component with status snapshot, timeline, and actions"
```

---

### Task 7: Wire WorkItemStream into the app

**Files:**
- Modify: `src/App.tsx` or parent component that currently opens ContextPane
- Modify: `src/components/Inbox.tsx` (or wherever work items are clicked)

- [ ] **Step 1: Find where ContextPane is opened**

Search for `ContextPane` usage in the app. It will be imported and rendered conditionally when a work item is selected. Replace with `WorkItemStream` as the default detail view.

- [ ] **Step 2: Import WorkItemStream alongside ContextPane**

In the parent component (likely `src/App.tsx` or `src/components/Inbox.tsx`):

```typescript
import WorkItemStream from "./components/WorkItemStream";
```

- [ ] **Step 3: Replace ContextPane rendering with WorkItemStream**

Where ContextPane is currently rendered, replace:

```tsx
{selectedWorkItemId && (
  <WorkItemStream
    workItemId={selectedWorkItemId}
    onClose={() => setSelectedWorkItemId(null)}
    onActioned={refreshInbox}
  />
)}
```

Keep the ContextPane import available — we're not deleting it yet, just swapping the default.

- [ ] **Step 4: Test manually**

Run: `cd ~/Code/workstream-ai && npm run dev`

Open the app, click a work item. Verify:
- Status snapshot shows at the top (title, unified status, agents, channels)
- Timeline shows collapsed with stats (click to expand)
- Timeline entries are grouped by day
- Clicking an entry expands the excerpt inline
- Decision entries (if any) have cyan left border
- Suggested actions appear at the bottom for blocked items

- [ ] **Step 5: Commit**

```bash
cd ~/Code/workstream-ai
git add src/App.tsx src/components/Inbox.tsx
git commit -m "feat: wire WorkItemStream as default detail view"
```

---

### Task 8: Pass workItemId to reply endpoint from frontend

**Files:**
- Modify: `src/lib/api.ts` (update postReply signature)
- Modify: `src/components/WorkItemStream.tsx` (if reply is added later)

This is needed so that operator replies get captured as decision events (Task 2 step 6).

- [ ] **Step 1: Update postReply to accept and pass workItemId**

In `src/lib/api.ts`, find the `postReply` function. Add `workItemId` to the request body:

```typescript
export async function postReply(
  threadId: string | undefined,
  channelId: string | undefined,
  message: string,
  opts?: { targetUserId?: string; workItemId?: string },
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/api/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      channelId,
      message,
      targetUserId: opts?.targetUserId,
      workItemId: opts?.workItemId,
    }),
  });
  return res.json();
}
```

- [ ] **Step 2: Update ContextPane to pass workItemId when replying**

In `src/components/ContextPane.tsx`, update `handleReplySubmit` to include the workItemId:

```typescript
await postReply(thread.id, thread.channelId, serializedText, { workItemId });
```

- [ ] **Step 3: Commit**

```bash
cd ~/Code/workstream-ai
git add src/lib/api.ts src/components/ContextPane.tsx
git commit -m "feat: pass workItemId in reply requests for decision event capture"
```

---

### Task 9: Run full test suite and fix any breakage

**Files:**
- Various test files that may need `entryType` added to mocks/assertions

- [ ] **Step 1: Run full test suite**

Run: `cd ~/Code/workstream-ai && npx vitest run --reporter=verbose`

- [ ] **Step 2: Fix any failures**

Common fixes needed:
- Test helpers that create mock Events need `entryType: "progress"` added
- Test helpers that create mock Classifications need `entryType: "progress"` added
- Assertions that check exact Event shapes need `entryType` included
- Pipeline test mock `makeClassification()` needs the field

For each failing test, add the missing `entryType` field with the appropriate default value.

- [ ] **Step 3: Run tests again to confirm all pass**

Run: `cd ~/Code/workstream-ai && npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd ~/Code/workstream-ai
git add -A
git commit -m "fix: update tests for entryType field on events and classifications"
```
