# AI Sidekick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a natural language query interface (AI Sidekick) that lets the operator ask questions about their fleet, grounded in the context graph — replacing search/filter, morning briefings, and "what do we have open?" conversations.

**Architecture:** The sidekick uses a tool-use pattern: the operator's question goes to the LLM with tool schemas describing available queries over the context graph. The LLM generates tool calls, the backend executes them against ContextGraph methods (read-only), and the LLM synthesizes an answer. A new `POST /api/sidekick` endpoint handles the full loop. The frontend adds a Cmd+K triggered slide-up panel.

**Tech Stack:** TypeScript, Hono (backend), React + Tailwind (frontend), OpenAI-compatible LLM API with tool-use (Anthropic messages API), SQLite (existing context graph)

**Depends on:** Context Pane and Fleet Board plans should be completed first (shared ContextGraph query methods and UI patterns)

---

## File Structure

### New files
- `core/sidekick/index.ts` — Sidekick orchestrator: question → tool calls → answer
- `core/sidekick/tools.ts` — Tool schemas and executor functions
- `core/sidekick/system-prompt.ts` — System prompt for the sidekick
- `src/components/Sidekick.tsx` — Slide-up panel with chat-style UI
- `tests/sidekick/sidekick.test.ts` — Sidekick orchestration tests
- `tests/sidekick/tools.test.ts` — Tool executor tests
- `tests/server/sidekick-api.test.ts` — Endpoint integration tests

### Modified files
- `core/graph/index.ts` — Add query methods: `searchWorkItems`, `getWorkItemsByAgent`, `getEventsSince`, `getAgentByName`, `getFleetStats`
- `core/config.ts` — Add `sidekick` config section
- `config/default.yaml` — Add `sidekick` defaults
- `core/server.ts` — Add `POST /api/sidekick` endpoint
- `src/lib/api.ts` — Add `askSidekick()` function + types
- `src/App.tsx` — Add Cmd+K shortcut and sidekick panel state

---

### Task 1: New ContextGraph Query Methods

**Files:**
- Modify: `core/graph/index.ts`
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/graph/db.test.ts`:

```typescript
describe("sidekick query methods", () => {
  beforeEach(() => {
    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertAgent({ id: "a2", name: "Pixel", platform: "slack", platformUserId: "U2" });

    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login bug", currentAtcStatus: "in_progress" });
    graph.upsertWorkItem({ id: "AI-200", source: "jira", title: "Add dark mode", currentAtcStatus: "blocked_on_human" });
    graph.upsertWorkItem({ id: "AI-300", source: "jira", title: "Update API docs", currentAtcStatus: "completed" });

    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "slack", workItemId: "AI-200" });
    graph.upsertThread({ id: "t3", channelId: "C1", platform: "slack", workItemId: "AI-300" });

    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
      status: "in_progress", confidence: 0.9, rawText: "Working on login fix",
      timestamp: "2026-04-01T08:00:00Z",
    });
    graph.insertEvent({
      threadId: "t2", messageId: "m2", workItemId: "AI-200", agentId: "a2",
      status: "blocked_on_human", confidence: 0.95, rawText: "Need approval for design",
      timestamp: "2026-04-01T09:00:00Z",
    });
    graph.insertEvent({
      threadId: "t3", messageId: "m3", workItemId: "AI-300", agentId: "a1",
      status: "completed", confidence: 0.9, rawText: "Docs updated",
      timestamp: "2026-04-01T10:00:00Z",
    });
  });

  it("searchWorkItems finds by ID", () => {
    const results = graph.searchWorkItems("AI-100");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AI-100");
  });

  it("searchWorkItems finds by title substring", () => {
    const results = graph.searchWorkItems("login");
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("login");
  });

  it("searchWorkItems returns empty for no match", () => {
    const results = graph.searchWorkItems("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("getWorkItemsByAgent returns items for a specific agent", () => {
    const results = graph.getWorkItemsByAgent("a1");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("AI-100");
  });

  it("getEventsSince returns events after a date", () => {
    const since = new Date("2026-04-01T08:30:00Z");
    const results = graph.getEventsSince(since);
    expect(results).toHaveLength(2); // m2 and m3
    expect(results[0].timestamp >= since.toISOString()).toBe(true);
  });

  it("getAgentByName finds by case-insensitive name", () => {
    const agent = graph.getAgentByName("byte");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Byte");
  });

  it("getAgentByName returns null for unknown name", () => {
    const agent = graph.getAgentByName("UnknownBot");
    expect(agent).toBeNull();
  });

  it("getFleetStats returns aggregate counts by status", () => {
    const stats = graph.getFleetStats();
    expect(stats.in_progress).toBe(1);
    expect(stats.blocked_on_human).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.total).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/db.test.ts -t "sidekick query methods"`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement the query methods**

Add to `core/graph/index.ts` in the ContextGraph class:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/db.test.ts -t "sidekick query methods"`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/index.ts tests/graph/db.test.ts
git commit -m "feat(graph): add sidekick query methods — search, agent lookup, fleet stats"
```

---

### Task 2: Sidekick Tool Definitions and Executor

**Files:**
- Create: `core/sidekick/tools.ts`
- Create: `tests/sidekick/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sidekick/tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { executeTool, TOOL_SCHEMAS } from "../../core/sidekick/tools.js";

describe("sidekick tools", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
      status: "in_progress", confidence: 0.9, rawText: "Working on login",
      timestamp: "2026-04-01T08:00:00Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("exports tool schemas", () => {
    expect(TOOL_SCHEMAS).toBeInstanceOf(Array);
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(0);
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toContain("query_work_items");
    expect(names).toContain("query_agents");
    expect(names).toContain("query_events");
    expect(names).toContain("get_fleet_stats");
  });

  it("executes query_work_items tool", () => {
    const result = executeTool(graph, "query_work_items", { query: "AI-100" });
    expect(result).toContain("AI-100");
  });

  it("executes query_agents tool", () => {
    const result = executeTool(graph, "query_agents", { name: "Byte" });
    expect(result).toContain("Byte");
  });

  it("executes query_events tool", () => {
    const result = executeTool(graph, "query_events", { since_hours: 24 });
    expect(result).toContain("AI-100");
  });

  it("executes get_fleet_stats tool", () => {
    const result = executeTool(graph, "get_fleet_stats", {});
    expect(result).toContain("in_progress");
    expect(result).toContain("total");
  });

  it("returns error for unknown tool", () => {
    const result = executeTool(graph, "unknown_tool", {});
    expect(result).toContain("Unknown tool");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sidekick/tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement tool schemas and executor**

Create `core/sidekick/tools.ts`:

```typescript
import type { ContextGraph } from "../graph/index.js";

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "query_work_items",
    description: "Search work items by ID or title. Returns matching work items with their current status.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — matches against work item ID or title" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_agents",
    description: "Look up an agent by name and get their current work items.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (case-insensitive partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "query_events",
    description: "Get recent events (classified messages) from the fleet. Use to find out what happened in a time window.",
    input_schema: {
      type: "object",
      properties: {
        since_hours: { type: "number", description: "How many hours back to look (e.g. 8 for last 8 hours, 24 for last day)" },
        work_item_id: { type: "string", description: "Optional: filter events to a specific work item" },
      },
      required: ["since_hours"],
    },
  },
  {
    name: "get_fleet_stats",
    description: "Get aggregate statistics about the fleet: count of work items by status.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

export function executeTool(
  graph: ContextGraph,
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "query_work_items": {
      const query = args.query as string;
      const items = graph.searchWorkItems(query);
      if (items.length === 0) return `No work items found matching "${query}".`;
      return items
        .map((wi) =>
          `${wi.id}: "${wi.title}" — status: ${wi.currentAtcStatus ?? "unknown"}, assignee: ${wi.assignee ?? "unassigned"}, updated: ${wi.updatedAt}`,
        )
        .join("\n");
    }

    case "query_agents": {
      const name = args.name as string;
      const agent = graph.getAgentByName(name);
      if (!agent) return `No agent found matching "${name}".`;

      const workItems = graph.getWorkItemsByAgent(agent.id);
      const wiList = workItems
        .map((wi) => `  - ${wi.id}: "${wi.title}" (${wi.currentAtcStatus ?? "unknown"})`)
        .join("\n");

      return `Agent: ${agent.name} (${agent.platform})\nLast seen: ${agent.lastSeen}\nWork items:\n${wiList || "  (none)"}`;
    }

    case "query_events": {
      const sinceHours = args.since_hours as number;
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      let events = graph.getEventsSince(since);

      const workItemId = args.work_item_id as string | undefined;
      if (workItemId) {
        events = events.filter((e) => e.workItemId === workItemId);
      }

      if (events.length === 0) return `No events in the last ${sinceHours} hours.`;

      return events
        .map((e) =>
          `[${e.timestamp}] ${e.workItemId ?? "—"} (${e.status}): ${e.rawText.slice(0, 200)}`,
        )
        .join("\n");
    }

    case "get_fleet_stats": {
      const stats = graph.getFleetStats();
      return Object.entries(stats)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sidekick/tools.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/sidekick/tools.ts tests/sidekick/tools.test.ts
git commit -m "feat(sidekick): add tool schemas and executor for context graph queries"
```

---

### Task 3: Sidekick System Prompt

**Files:**
- Create: `core/sidekick/system-prompt.ts`

- [ ] **Step 1: Create the system prompt**

Create `core/sidekick/system-prompt.ts`:

```typescript
export const SIDEKICK_SYSTEM_PROMPT = `You are ATC Sidekick, an assistant that helps an agent fleet operator understand what's happening across their fleet.

You have access to tools that query the ATC context graph — a local database of work items, agent activity, and conversation events. Use these tools to answer the operator's questions with specific, grounded answers.

Guidelines:
- Always use tools to look up data before answering. Do not guess or make up work item IDs, agent names, or statuses.
- Be concise. The operator is busy — give them the answer, not a lecture.
- When listing work items, include the ID, title, status, and agent.
- When summarizing time periods, focus on what changed: what completed, what's newly blocked, what needs attention.
- If the query is ambiguous, make your best guess and answer — don't ask for clarification unless truly necessary.
- Reference work item IDs so the operator can click through to details.

You are read-only. You cannot take actions, send messages, or modify any data.`;
```

- [ ] **Step 2: Commit**

```bash
git add core/sidekick/system-prompt.ts
git commit -m "feat(sidekick): add system prompt for ATC sidekick"
```

---

### Task 4: Sidekick Orchestrator

**Files:**
- Create: `core/sidekick/index.ts`
- Create: `tests/sidekick/sidekick.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sidekick/sidekick.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Sidekick } from "../../core/sidekick/index.js";

describe("Sidekick", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
      status: "in_progress", confidence: 0.9, rawText: "Working on login fix",
      timestamp: "2026-04-01T08:00:00Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("answers a question by calling tools and synthesizing a response", async () => {
    // Mock the LLM: first call returns a tool use, second call returns final answer
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First LLM call: returns tool_use
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "get_fleet_stats",
              input: {},
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      ),
    );

    // Second LLM call: returns text answer
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "You have 1 work item in progress (AI-100: Fix login).",
            },
          ],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      ),
    );

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 5,
    }, graph);

    const result = await sidekick.ask("How many items are in progress?", []);

    expect(result.answer).toContain("AI-100");
    expect(result.sources.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("handles LLM error gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("API timeout"),
    );

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 5,
    }, graph);

    const result = await sidekick.ask("What's happening?", []);

    expect(result.answer).toContain("unable");
    expect(result.sources).toEqual([]);

    fetchSpy.mockRestore();
  });

  it("respects maxToolCalls limit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Return tool_use every time to test the limit
    for (let i = 0; i < 3; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [{ type: "tool_use", id: `tu_${i}`, name: "get_fleet_stats", input: {} }],
            stop_reason: "tool_use",
          }),
          { status: 200 },
        ),
      );
    }

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 2,
    }, graph);

    const result = await sidekick.ask("What's happening?", []);

    // Should have stopped after 2 tool calls
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.answer.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sidekick/sidekick.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the Sidekick orchestrator**

Create `core/sidekick/index.ts`:

```typescript
import { createLogger } from "../logger.js";
import { SIDEKICK_SYSTEM_PROMPT } from "./system-prompt.js";
import { TOOL_SCHEMAS, executeTool } from "./tools.js";
import type { ContextGraph } from "../graph/index.js";

const log = createLogger("sidekick");

export interface SidekickConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxToolCalls: number;
}

export interface SidekickMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SidekickSource {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface SidekickResult {
  answer: string;
  sources: SidekickSource[];
}

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

export class Sidekick {
  private readonly config: SidekickConfig;
  private readonly graph: ContextGraph;
  private readonly isAnthropic: boolean;

  constructor(config: SidekickConfig, graph: ContextGraph) {
    this.config = config;
    this.graph = graph;
    this.isAnthropic = config.baseUrl.includes("anthropic");
  }

  async ask(question: string, history: SidekickMessage[]): Promise<SidekickResult> {
    const sources: SidekickSource[] = [];

    try {
      // Build initial messages from history + new question
      const messages: Array<{ role: string; content: unknown }> = [];
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: "user", content: question });

      let toolCallCount = 0;

      // Loop: send to LLM, execute tools, repeat until text response or limit
      while (toolCallCount < this.config.maxToolCalls) {
        const response = await this.callLLM(messages);

        // Check for tool use blocks
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        const textBlocks = response.content.filter((b) => b.type === "text");

        if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
          // Final text response
          const answer = textBlocks.map((b) => b.text ?? "").join("\n");
          return { answer: answer || "I couldn't find an answer.", sources };
        }

        // Execute each tool call
        // Add the assistant's response (with tool_use blocks) to messages
        messages.push({ role: "assistant", content: response.content });

        const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

        for (const block of toolUseBlocks) {
          toolCallCount++;
          const toolName = block.name!;
          const toolArgs = block.input ?? {};

          log.debug(`Executing tool: ${toolName}`, toolArgs);
          const result = executeTool(this.graph, toolName, toolArgs);

          sources.push({ tool: toolName, args: toolArgs, result });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: result,
          });
        }

        // Add tool results to messages
        messages.push({ role: "user", content: toolResults });
      }

      // Hit max tool calls — synthesize from what we have
      const sourceText = sources.map((s) => s.result).join("\n\n");
      return {
        answer: sourceText || "I ran out of query budget. Try a more specific question.",
        sources,
      };
    } catch (error) {
      log.error("Sidekick query failed", error);
      return {
        answer: "Sorry, I was unable to process your question. The LLM may be unavailable.",
        sources: [],
      };
    }
  }

  private async callLLM(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    if (this.isAnthropic) {
      return this.callAnthropic(messages);
    }
    return this.callOpenAI(messages);
  }

  private async callAnthropic(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 1024,
        system: SIDEKICK_SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        messages,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    return (await response.json()) as AnthropicResponse;
  }

  private async callOpenAI(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // Convert tool schemas to OpenAI format
    const tools = TOOL_SCHEMAS.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const openaiMessages = [
      { role: "system", content: SIDEKICK_SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: openaiMessages,
        tools,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = json.choices[0];
    const content: AnthropicContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    return {
      content,
      stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sidekick/sidekick.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/sidekick/index.ts tests/sidekick/sidekick.test.ts
git commit -m "feat(sidekick): add orchestrator with tool-use loop for fleet queries"
```

---

### Task 5: Sidekick Config

**Files:**
- Modify: `core/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add sidekick to ConfigSchema**

In `core/config.ts`, add to the ConfigSchema:

```typescript
sidekick: z.object({
  enabled: z.boolean(),
  maxToolCalls: z.number(),
  maxHistoryTurns: z.number(),
}).optional().default({
  enabled: true,
  maxToolCalls: 5,
  maxHistoryTurns: 10,
}),
```

- [ ] **Step 2: Add sidekick section to config/default.yaml**

Add to `config/default.yaml`:

```yaml
sidekick:
  enabled: true
  maxToolCalls: 5
  maxHistoryTurns: 10
```

- [ ] **Step 3: Run config tests**

Run: `npx vitest run tests/core/config.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add core/config.ts config/default.yaml
git commit -m "feat(config): add sidekick configuration section"
```

---

### Task 6: Sidekick API Endpoint

**Files:**
- Modify: `core/server.ts`
- Create: `tests/server/sidekick-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/sidekick-api.test.ts`:

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
      classifier: { provider: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", apiKey: "test" }, confidenceThreshold: 0.6 },
      jira: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      sidekick: { enabled: true, maxToolCalls: 5, maxHistoryTurns: 10 },
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

describe("POST /api/sidekick", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns an answer for a valid question", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // LLM returns a direct text answer (no tool use)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "There is 1 work item in progress." }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      ),
    );

    const app = createApp(state);
    const res = await app.request("/api/sidekick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How many items are active?", history: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toContain("1 work item");

    fetchSpy.mockRestore();
  });

  it("returns 400 for missing question", async () => {
    const app = createApp(state);
    const res = await app.request("/api/sidekick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: [] }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/sidekick-api.test.ts`
Expected: FAIL — 404

- [ ] **Step 3: Add the sidekick endpoint to server.ts**

In `core/server.ts`, add the import:
```typescript
import { Sidekick, type SidekickMessage } from "./sidekick/index.js";
```

Add the endpoint:

```typescript
// --- POST /api/sidekick ---
app.post("/api/sidekick", async (c) => {
  const body = await c.req.json<{
    question?: string;
    history?: SidekickMessage[];
  }>();

  if (!body.question) {
    return c.json({ error: "Missing required field: question" }, 400);
  }

  const sidekickConfig = (state.config as any).sidekick ?? {
    enabled: true,
    maxToolCalls: 5,
    maxHistoryTurns: 10,
  };

  const { baseUrl, model, apiKey } = state.config.classifier.provider;
  const sidekick = new Sidekick(
    { baseUrl, model, apiKey, maxToolCalls: sidekickConfig.maxToolCalls },
    state.graph,
  );

  const history = (body.history ?? []).slice(-sidekickConfig.maxHistoryTurns);
  const result = await sidekick.ask(body.question, history);

  return c.json(result);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/sidekick-api.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/server/sidekick-api.test.ts
git commit -m "feat(server): add POST /api/sidekick endpoint"
```

---

### Task 7: Frontend API — Sidekick Types and Fetch

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add sidekick types and fetch function**

Add to `src/lib/api.ts`:

```typescript
export interface SidekickMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SidekickResult {
  answer: string;
  sources: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
}

export function askSidekick(
  question: string,
  history: SidekickMessage[],
): Promise<SidekickResult> {
  return apiFetch("/api/sidekick", {
    method: "POST",
    body: JSON.stringify({ question, history }),
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add askSidekick API function"
```

---

### Task 8: Sidekick React Component

**Files:**
- Create: `src/components/Sidekick.tsx`

- [ ] **Step 1: Create the Sidekick panel component**

Create `src/components/Sidekick.tsx`:

```tsx
import { useState, useRef, useEffect, type JSX } from "react";
import { askSidekick, type SidekickMessage, type SidekickResult } from "../lib/api";

interface SidekickProps {
  onClose: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function Sidekick({ onClose }: SidekickProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const newMessages: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      // Build history for the API (exclude the current question)
      const history: SidekickMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const result = await askSidekick(question, history);
      setMessages([...newMessages, { role: "assistant", content: result.answer }]);
    } catch (err) {
      setMessages([
        ...newMessages,
        { role: "assistant", content: "Sorry, I couldn't process that question." },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center">
      <div
        ref={panelRef}
        className="w-full max-w-2xl bg-gray-950 border border-gray-800 border-b-0 rounded-t-xl shadow-2xl flex flex-col"
        style={{ height: "40vh", minHeight: 300 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-300">Ask ATC</span>
            <span className="text-xs text-gray-600">Cmd+K</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
          >
            ✕
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500">
                Ask me anything about your fleet.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {[
                  "What happened overnight?",
                  "Which items are blocked?",
                  "What is Byte working on?",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                    className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:text-gray-200 hover:border-gray-600"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-sm ${
                msg.role === "user"
                  ? "text-gray-200 font-medium"
                  : "text-gray-400 whitespace-pre-wrap"
              }`}
            >
              {msg.role === "user" ? (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-gray-600 mt-0.5">You:</span>
                  <span>{msg.content}</span>
                </div>
              ) : (
                <div className="bg-gray-900 rounded-lg px-3 py-2 border border-gray-800/50">
                  {msg.content}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="text-sm text-gray-500 animate-pulse">
              Thinking...
            </div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="border-t border-gray-800 px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your fleet..."
            disabled={loading}
            className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-600 focus:outline-none disabled:opacity-50"
          />
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidekick.tsx
git commit -m "feat(ui): add Sidekick slide-up panel component"
```

---

### Task 9: Wire Sidekick into App.tsx with Cmd+K

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add sidekick state and keyboard shortcut**

In `src/App.tsx`:

Add the import:
```typescript
import Sidekick from "./components/Sidekick";
```

Add state after existing state:
```typescript
const [sidekickOpen, setSidekickOpen] = useState(false);
```

Update the existing keyboard shortcut useEffect to also handle Cmd+K. Add a new useEffect (or extend the existing one):

```typescript
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSidekickOpen((open) => !open);
    }
  }
  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, []);
```

Add the sidekick render at the end of the component, just before the closing `</div>`:

```tsx
{sidekickOpen && <Sidekick onClose={() => setSidekickOpen(false)} />}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): wire Sidekick into App with Cmd+K shortcut"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Visual verification**

Run: `npm run dev:web`
Verify:
- Cmd+K opens the sidekick panel from the bottom
- Suggestion chips populate the input
- Typing a question and pressing Enter sends it
- Loading indicator shows while processing
- Answer appears in the chat area
- Multi-turn conversation works
- Escape or ✕ closes the panel
- Cmd+K toggles open/close

- [ ] **Step 3: Fix any issues, commit if needed**

```bash
git add -A
git commit -m "fix: sidekick polish and integration fixes"
```
