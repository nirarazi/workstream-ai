# Fleet Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Fleet Board tab showing all active work items in a compact table with anomaly detection badges and search/filter capabilities — replacing the operator's "what do we have open?" conversations.

**Architecture:** A new `GET /api/fleet` endpoint returns all non-completed work items with anomaly flags computed server-side. A pure function `detectAnomalies()` runs at query time over existing data — no new tables or background jobs. The frontend adds a tab bar to App.tsx and a new FleetBoard component with client-side filtering.

**Tech Stack:** TypeScript, Hono (backend), React + Tailwind (frontend), SQLite (existing context graph)

**Depends on:** Context Pane plan must be completed first (FleetBoard imports ContextPane component)

---

## File Structure

### New files
- `core/graph/anomalies.ts` — Pure function for anomaly detection
- `src/components/FleetBoard.tsx` — Table view with anomaly badges
- `src/components/FleetFilters.tsx` — Search bar and filter dropdowns
- `tests/graph/anomalies.test.ts` — Anomaly detection unit tests
- `tests/server/fleet-api.test.ts` — Fleet endpoint integration tests

### Modified files
- `core/config.ts` — Add `anomalies` config section to schema
- `config/default.yaml` — Add `anomalies` thresholds
- `core/graph/index.ts` — Add `getFleetItems()` method
- `core/server.ts` — Add `GET /api/fleet` endpoint
- `src/lib/api.ts` — Add `fetchFleet()` function + fleet types
- `src/App.tsx` — Add tab bar, fleet view state

---

### Task 1: Anomaly Detection Config

**Files:**
- Modify: `core/config.ts`
- Modify: `config/default.yaml`
- Test: `tests/core/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/config.test.ts`:

```typescript
it("loads anomaly thresholds config", () => {
  const config = loadConfig(projectRoot);
  expect(config.anomalies).toBeDefined();
  expect(config.anomalies.staleThresholdHours).toBe(4);
  expect(config.anomalies.silentAgentThresholdHours).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/config.test.ts -t "loads anomaly"`
Expected: FAIL

- [ ] **Step 3: Add anomalies to ConfigSchema**

In `core/config.ts`, add to `ConfigSchema` after the `server` field:

```typescript
anomalies: z.object({
  staleThresholdHours: z.number(),
  silentAgentThresholdHours: z.number(),
}).optional().default({
  staleThresholdHours: 4,
  silentAgentThresholdHours: 2,
}),
```

- [ ] **Step 4: Add anomalies section to config/default.yaml**

Add to `config/default.yaml`:

```yaml
anomalies:
  staleThresholdHours: 4
  silentAgentThresholdHours: 2
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/config.test.ts -t "loads anomaly"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/config.ts config/default.yaml tests/core/config.test.ts
git commit -m "feat(config): add anomaly detection thresholds"
```

---

### Task 2: Anomaly Detection Pure Function

**Files:**
- Create: `core/graph/anomalies.ts`
- Create: `tests/graph/anomalies.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/graph/anomalies.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectAnomalies, type AnomalyFlag, type FleetItemInput } from "../../core/graph/anomalies.js";

const NOW = new Date("2026-04-01T12:00:00Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

const defaultConfig = {
  staleThresholdHours: 4,
  silentAgentThresholdHours: 2,
};

describe("detectAnomalies", () => {
  it("returns empty array for healthy in-progress item", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toEqual([]);
  });

  it("detects stale item (no events for >threshold hours)", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(5),
      agentLastSeen: hoursAgo(5),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "stale" }),
    );
  });

  it("does NOT flag stale for completed items", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "completed",
      latestEventTimestamp: hoursAgo(10),
      agentLastSeen: hoursAgo(10),
      eventStatuses: ["completed"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies.find((a) => a.type === "stale")).toBeUndefined();
  });

  it("detects silent agent", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(3),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "silent_agent" }),
    );
  });

  it("detects status regression", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "blocked_on_human",
      latestEventTimestamp: hoursAgo(0.5),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress", "completed", "blocked_on_human"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "status_regression" }),
    );
  });

  it("detects duplicate work items by title", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login bug",
    };

    const otherItems: FleetItemInput[] = [
      {
        workItemId: "AI-2",
        currentAtcStatus: "in_progress",
        latestEventTimestamp: hoursAgo(2),
        agentLastSeen: hoursAgo(1),
        eventStatuses: ["in_progress"],
        title: "Fix login bug",
      },
    ];

    const anomalies = detectAnomalies(item, otherItems, defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "duplicate_work" }),
    );
  });

  it("does not flag duplicate for different titles", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login bug",
    };

    const otherItems: FleetItemInput[] = [
      {
        workItemId: "AI-2",
        currentAtcStatus: "in_progress",
        latestEventTimestamp: hoursAgo(2),
        agentLastSeen: hoursAgo(1),
        eventStatuses: ["in_progress"],
        title: "Add signup page",
      },
    ];

    const anomalies = detectAnomalies(item, otherItems, defaultConfig, NOW);
    expect(anomalies.find((a) => a.type === "duplicate_work")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/anomalies.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the anomaly detection function**

Create `core/graph/anomalies.ts`:

```typescript
export interface FleetItemInput {
  workItemId: string;
  currentAtcStatus: string | null;
  latestEventTimestamp: string;
  agentLastSeen: string | null;
  eventStatuses: string[];
  title: string;
}

export interface AnomalyFlag {
  type: "stale" | "silent_agent" | "status_regression" | "duplicate_work";
  message: string;
}

export interface AnomalyConfig {
  staleThresholdHours: number;
  silentAgentThresholdHours: number;
}

export function detectAnomalies(
  item: FleetItemInput,
  otherItems: FleetItemInput[],
  config: AnomalyConfig,
  now: Date = new Date(),
): AnomalyFlag[] {
  const anomalies: AnomalyFlag[] = [];
  const nowMs = now.getTime();

  // Stale: no new events for >threshold hours on an active item
  const activeStatuses = new Set(["in_progress", "blocked_on_human", "needs_decision"]);
  if (activeStatuses.has(item.currentAtcStatus ?? "")) {
    const lastEventMs = new Date(item.latestEventTimestamp).getTime();
    const hoursSinceEvent = (nowMs - lastEventMs) / (1000 * 60 * 60);
    if (hoursSinceEvent > config.staleThresholdHours) {
      anomalies.push({
        type: "stale",
        message: `No activity for ${Math.floor(hoursSinceEvent)}h`,
      });
    }
  }

  // Silent agent: agent's last_seen is >threshold while they have active work
  if (
    activeStatuses.has(item.currentAtcStatus ?? "") &&
    item.agentLastSeen
  ) {
    const agentLastMs = new Date(item.agentLastSeen).getTime();
    const hoursSinceAgent = (nowMs - agentLastMs) / (1000 * 60 * 60);
    if (hoursSinceAgent > config.silentAgentThresholdHours) {
      anomalies.push({
        type: "silent_agent",
        message: `Agent silent for ${Math.floor(hoursSinceAgent)}h`,
      });
    }
  }

  // Status regression: went from in_progress/completed back to blocked
  if (item.eventStatuses.length >= 2) {
    const current = item.eventStatuses[item.eventStatuses.length - 1];
    const previous = item.eventStatuses.slice(0, -1);
    const progressedBefore =
      previous.includes("in_progress") || previous.includes("completed");
    const regressedNow =
      current === "blocked_on_human" || current === "needs_decision";

    if (progressedBefore && regressedNow) {
      anomalies.push({
        type: "status_regression",
        message: "Status regressed to blocked",
      });
    }
  }

  // Duplicate work: same non-empty title as another active item
  if (item.title && item.title.length > 0) {
    const duplicate = otherItems.find(
      (other) =>
        other.workItemId !== item.workItemId &&
        other.title === item.title &&
        activeStatuses.has(other.currentAtcStatus ?? ""),
    );
    if (duplicate) {
      anomalies.push({
        type: "duplicate_work",
        message: `Same title as ${duplicate.workItemId}`,
      });
    }
  }

  return anomalies;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/anomalies.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/anomalies.ts tests/graph/anomalies.test.ts
git commit -m "feat(anomalies): add pure function for fleet anomaly detection"
```

---

### Task 3: ContextGraph — getFleetItems Method

**Files:**
- Modify: `core/graph/index.ts`
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/graph/db.test.ts`:

```typescript
describe("getFleetItems", () => {
  it("returns all non-completed work items with latest event and agent", () => {
    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Active task", currentAtcStatus: "in_progress" });
    graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Done task", currentAtcStatus: "completed" });
    graph.upsertWorkItem({ id: "AI-3", source: "jira", title: "Blocked task", currentAtcStatus: "blocked_on_human" });

    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });
    graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-3" });

    graph.insertEvent({ threadId: "t1", messageId: "m1", workItemId: "AI-1", agentId: "a1", status: "in_progress", confidence: 0.9, timestamp: "2026-04-01T08:00:00Z" });
    graph.insertEvent({ threadId: "t2", messageId: "m2", workItemId: "AI-2", agentId: "a1", status: "completed", confidence: 0.95, timestamp: "2026-04-01T09:00:00Z" });
    graph.insertEvent({ threadId: "t3", messageId: "m3", workItemId: "AI-3", agentId: "a1", status: "blocked_on_human", confidence: 0.9, timestamp: "2026-04-01T10:00:00Z" });

    const items = graph.getFleetItems();

    // Should exclude completed
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.workItem.id);
    expect(ids).toContain("AI-1");
    expect(ids).toContain("AI-3");
    expect(ids).not.toContain("AI-2");
  });

  it("returns items with no events (newly created work items)", () => {
    graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "New task", currentAtcStatus: "in_progress" });

    const items = graph.getFleetItems();
    expect(items).toHaveLength(1);
    expect(items[0].workItem.id).toBe("AI-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/db.test.ts -t "getFleetItems"`
Expected: FAIL — `graph.getFleetItems is not a function`

- [ ] **Step 3: Implement getFleetItems in ContextGraph**

Add to `core/graph/index.ts` in the ContextGraph class:

```typescript
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
      a.id AS a_id, a.name AS a_name, a.platform AS a_platform,
      a.platform_user_id AS a_platform_user_id, a.role AS a_role,
      a.avatar_url AS a_avatar_url,
      a.first_seen AS a_first_seen, a.last_seen AS a_last_seen,
      t.id AS t_id, t.channel_id AS t_channel_id, t.channel_name AS t_channel_name,
      t.platform_meta AS t_platform_meta,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/db.test.ts -t "getFleetItems"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/index.ts tests/graph/db.test.ts
git commit -m "feat(graph): add getFleetItems method returning non-completed work items"
```

---

### Task 4: Fleet API Endpoint

**Files:**
- Modify: `core/server.ts`
- Create: `tests/server/fleet-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/fleet-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

function makeState(): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifier = new Classifier(
    { name: "mock", classify: vi.fn() },
    "sys",
    [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: [], prPatterns: [] }),
  ]);
  return {
    config: {
      slack: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
      jira: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      anomalies: { staleThresholdHours: 4, silentAgentThresholdHours: 2 },
    } as any,
    db,
    graph,
    classifier,
    linker,
    pipeline: null,
    platformAdapter: null,
    taskAdapter: null,
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
    summarizer: null,
  } as any;
}

describe("GET /api/fleet", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-1", source: "jira", title: "Active", currentAtcStatus: "in_progress" });
    state.graph.upsertWorkItem({ id: "AI-2", source: "jira", title: "Done", currentAtcStatus: "completed" });

    state.graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    state.graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-2" });

    state.graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-1", agentId: "a1",
      status: "in_progress", confidence: 0.9, timestamp: "2026-04-01T08:00:00Z",
    });
    state.graph.insertEvent({
      threadId: "t2", messageId: "m2", workItemId: "AI-2", agentId: "a1",
      status: "completed", confidence: 0.95, timestamp: "2026-04-01T09:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns non-completed items with anomaly flags", async () => {
    const app = createApp(state);
    const res = await app.request("/api/fleet");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].workItem.id).toBe("AI-1");
    expect(body.items[0].anomalies).toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/fleet-api.test.ts`
Expected: FAIL — 404

- [ ] **Step 3: Add the fleet endpoint to server.ts**

In `core/server.ts`, add the import:
```typescript
import { detectAnomalies, type FleetItemInput } from "./graph/anomalies.js";
```

Add the endpoint after the existing routes:

```typescript
// --- GET /api/fleet ---
app.get("/api/fleet", (c) => {
  const items = state.graph.getFleetItems();

  // Build fleet inputs for anomaly detection
  const fleetInputs: FleetItemInput[] = items.map((item) => {
    const events = state.graph.getEventsForWorkItem(item.workItem.id);
    return {
      workItemId: item.workItem.id,
      currentAtcStatus: item.workItem.currentAtcStatus,
      latestEventTimestamp: item.latestEvent?.timestamp ?? item.workItem.updatedAt,
      agentLastSeen: item.agent?.lastSeen ?? null,
      eventStatuses: events.map((e) => e.status),
      title: item.workItem.title,
    };
  });

  const anomalyConfig = (state.config as any).anomalies ?? {
    staleThresholdHours: 4,
    silentAgentThresholdHours: 2,
  };

  const now = new Date();
  const enrichedItems = items.map((item, idx) => {
    const anomalies = detectAnomalies(
      fleetInputs[idx],
      fleetInputs.filter((_, i) => i !== idx),
      anomalyConfig,
      now,
    );
    return { ...item, anomalies };
  });

  return c.json({ items: enrichedItems });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/fleet-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/server/fleet-api.test.ts
git commit -m "feat(server): add GET /api/fleet endpoint with anomaly detection"
```

---

### Task 5: Frontend API — Fleet Types and Fetch

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add fleet types and fetch function**

Add to `src/lib/api.ts`:

```typescript
export interface AnomalyFlag {
  type: "stale" | "silent_agent" | "status_regression" | "duplicate_work";
  message: string;
}

export interface FleetItem extends ActionableItem {
  anomalies: AnomalyFlag[];
}

export function fetchFleet(): Promise<{ items: FleetItem[] }> {
  return apiFetch("/api/fleet");
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add fetchFleet API function and FleetItem type"
```

---

### Task 6: FleetFilters Component

**Files:**
- Create: `src/components/FleetFilters.tsx`

- [ ] **Step 1: Create the filter bar component**

Create `src/components/FleetFilters.tsx`:

```tsx
import { type JSX } from "react";
import type { Agent } from "../lib/api";

interface FleetFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: string[];
  onStatusFilterChange: (statuses: string[]) => void;
  agentFilter: string[];
  onAgentFilterChange: (agentIds: string[]) => void;
  anomalyOnly: boolean;
  onAnomalyOnlyChange: (value: boolean) => void;
  agents: Agent[];
}

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In Progress" },
  { value: "blocked_on_human", label: "Blocked" },
  { value: "needs_decision", label: "Needs Decision" },
  { value: "noise", label: "Noise" },
];

export default function FleetFilters({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  agentFilter,
  onAgentFilterChange,
  anomalyOnly,
  onAnomalyOnlyChange,
  agents,
}: FleetFiltersProps): JSX.Element {
  function toggleStatus(status: string) {
    if (statusFilter.includes(status)) {
      onStatusFilterChange(statusFilter.filter((s) => s !== status));
    } else {
      onStatusFilterChange([...statusFilter, status]);
    }
  }

  function toggleAgent(agentId: string) {
    if (agentFilter.includes(agentId)) {
      onAgentFilterChange(agentFilter.filter((a) => a !== agentId));
    } else {
      onAgentFilterChange([...agentFilter, agentId]);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      {/* Search */}
      <input
        type="text"
        placeholder="Search work items..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-600 focus:outline-none w-56"
      />

      {/* Status filter pills */}
      <div className="flex items-center gap-1">
        {STATUS_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => toggleStatus(value)}
            className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
              statusFilter.includes(value)
                ? "bg-blue-900/60 text-blue-300 border-blue-700/50"
                : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Agent filter dropdown */}
      {agents.length > 0 && (
        <select
          multiple
          value={agentFilter}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions, (o) => o.value);
            onAgentFilterChange(selected);
          }}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 max-h-24 overflow-y-auto"
          title="Filter by agent"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      )}

      {/* Anomaly-only toggle */}
      <button
        onClick={() => onAnomalyOnlyChange(!anomalyOnly)}
        className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
          anomalyOnly
            ? "bg-red-900/60 text-red-300 border-red-700/50"
            : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
        }`}
      >
        Anomalies only
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/FleetFilters.tsx
git commit -m "feat(ui): add FleetFilters search and filter bar component"
```

---

### Task 7: FleetBoard Component

**Files:**
- Create: `src/components/FleetBoard.tsx`

- [ ] **Step 1: Create the FleetBoard table component**

Create `src/components/FleetBoard.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchFleet, fetchAgents, agentsToMentionables, type FleetItem, type Agent, type Mentionable } from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import FleetFilters from "./FleetFilters";
import ContextPane from "./ContextPane";

const POLL_INTERVAL = 10000;

interface FleetBoardProps {
  platformMeta?: Record<string, unknown>;
}

const ANOMALY_ICONS: Record<string, { icon: string; color: string }> = {
  stale: { icon: "⏰", color: "text-amber-400" },
  silent_agent: { icon: "⚠", color: "text-red-400" },
  status_regression: { icon: "↓", color: "text-red-400" },
  duplicate_work: { icon: "🔗", color: "text-purple-400" },
};

export default function FleetBoard({ platformMeta }: FleetBoardProps): JSX.Element {
  const [items, setItems] = useState<FleetItem[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map());
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [agentFilter, setAgentFilter] = useState<string[]>([]);
  const [anomalyOnly, setAnomalyOnly] = useState(false);

  // Context pane state
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const [fleetRes, agentsRes] = await Promise.all([fetchFleet(), fetchAgents()]);
      setItems(fleetRes.items);
      setAgents(agentsRes.agents);

      const map = new Map<string, string>();
      for (const a of agentsRes.agents) {
        if (a.platformUserId) map.set(a.platformUserId, a.name);
      }
      setUserMap(map);
      setMentionables(agentsToMentionables(agentsRes.agents));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [poll]);

  // Client-side filtering
  const filtered = items.filter((item) => {
    const q = searchQuery.toLowerCase();
    if (q) {
      const matchesSearch =
        item.workItem.id.toLowerCase().includes(q) ||
        item.workItem.title.toLowerCase().includes(q) ||
        (item.agent?.name ?? "").toLowerCase().includes(q);
      if (!matchesSearch) return false;
    }
    if (statusFilter.length > 0 && !statusFilter.includes(item.workItem.currentAtcStatus ?? "")) {
      return false;
    }
    if (agentFilter.length > 0 && (!item.agent || !agentFilter.includes(item.agent.id))) {
      return false;
    }
    if (anomalyOnly && item.anomalies.length === 0) {
      return false;
    }
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading fleet...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm text-red-400">Unable to reach the ATC engine.</p>
        <p className="text-xs text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div>
      <FleetFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
        anomalyOnly={anomalyOnly}
        onAnomalyOnlyChange={setAnomalyOnly}
        agents={agents}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-3 py-2">Work Item</th>
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 hidden md:table-cell">External</th>
              <th className="px-3 py-2">Last Activity</th>
              <th className="px-3 py-2">Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr
                key={item.workItem.id}
                onClick={() => setSelectedWorkItemId(item.workItem.id)}
                className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer transition-colors"
              >
                <td className="px-3 py-2.5">
                  <span className="font-mono text-sm font-semibold text-blue-400">
                    {item.workItem.id}
                  </span>
                  {item.workItem.title && (
                    <p className="text-xs text-gray-400 truncate max-w-48">
                      {item.workItem.title}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {item.agent ? (
                    <div className="flex items-center gap-2">
                      {item.agent.avatarUrl ? (
                        <img src={item.agent.avatarUrl} className="h-5 w-5 rounded-full" />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-700 text-xs text-gray-400">
                          {item.agent.name.charAt(0)}
                        </span>
                      )}
                      <span className="text-xs text-gray-300">{item.agent.name}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={item.workItem.currentAtcStatus ?? "noise"} />
                </td>
                <td className="px-3 py-2.5 hidden md:table-cell">
                  <span className="text-xs text-gray-500">
                    {item.workItem.externalStatus ?? "—"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-gray-500">
                    {item.latestEvent ? timeAgo(item.latestEvent.timestamp) : "—"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    {item.anomalies.map((anomaly, i) => {
                      const config = ANOMALY_ICONS[anomaly.type] ?? { icon: "?", color: "text-gray-400" };
                      return (
                        <span
                          key={i}
                          className={`text-xs ${config.color}`}
                          title={anomaly.message}
                        >
                          {config.icon}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-500">
            {items.length === 0 ? "No active work items." : "No items match filters."}
          </p>
        </div>
      )}

      {/* Shared context pane */}
      {selectedWorkItemId && (
        <ContextPane
          workItemId={selectedWorkItemId}
          platformMeta={platformMeta}
          userMap={userMap}
          mentionables={mentionables}
          onClose={() => setSelectedWorkItemId(null)}
          onActioned={() => setTimeout(poll, 500)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/FleetBoard.tsx
git commit -m "feat(ui): add FleetBoard table component with anomaly badges"
```

---

### Task 8: Tab Bar in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add fleet tab to App.tsx**

In `src/App.tsx`:

Add the import:
```typescript
import FleetBoard from "./components/FleetBoard";
```

Update the `View` type:
```typescript
type View = "loading" | "setup" | "inbox" | "fleet" | "settings";
```

Add a tab bar component right before `{/* Main content */}`. Insert between `</header>` and `<main>`:

```tsx
{/* Tab bar — only visible when configured */}
{(view === "inbox" || view === "fleet") && (
  <nav className="border-b border-gray-800 bg-gray-950 px-6 flex items-center gap-6">
    <button
      onClick={() => setView("inbox")}
      className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
        view === "inbox"
          ? "border-blue-500 text-gray-200"
          : "border-transparent text-gray-500 hover:text-gray-300"
      }`}
    >
      Inbox
    </button>
    <button
      onClick={() => setView("fleet")}
      className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
        view === "fleet"
          ? "border-blue-500 text-gray-200"
          : "border-transparent text-gray-500 hover:text-gray-300"
      }`}
    >
      Fleet
    </button>
  </nav>
)}
```

Add the fleet view render in the `<main>` block:
```tsx
{view === "fleet" && <FleetBoard platformMeta={platformMeta} />}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): add Inbox/Fleet tab bar to App.tsx"
```

---

### Task 9: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Visual verification**

Run: `npm run dev:web`
Verify:
- Tab bar shows "Inbox" and "Fleet" tabs
- Fleet tab shows all non-completed work items in a table
- Anomaly badges display correctly
- Search filters items by ID, title, agent name
- Status filter pills toggle correctly
- Anomaly-only toggle works
- Clicking a row opens the Context Pane
- Switching tabs preserves state

- [ ] **Step 3: Fix any issues, commit if needed**

```bash
git add -A
git commit -m "fix: fleet board polish and integration fixes"
```
