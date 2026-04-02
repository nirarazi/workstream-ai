# Context Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-out context pane to work item cards showing AI summary, Jira context, conversation thread, and suggested replies — so the operator never opens Slack/Jira to get context.

**Architecture:** Clicking a work item card opens a right-side pane (50% width overlay). A new `/api/work-item/:id/context` endpoint returns all context in one payload. A `Summarizer` module calls the operator's configured LLM to generate 3-5 bullet points from thread events. Summaries are cached in a new `summaries` SQLite table and invalidated when new events arrive.

**Tech Stack:** TypeScript, Hono (backend), React + Tailwind (frontend), SQLite (summary cache), OpenAI-compatible LLM API (via existing `OpenAICompatibleProvider`)

---

## File Structure

### New files
- `core/summarizer/index.ts` — Summarizer class: takes events, calls LLM, returns bullet points
- `core/summarizer/prompt.ts` — System prompt for summarization
- `src/components/ContextPane.tsx` — Slide-out detail panel component
- `tests/summarizer/summarizer.test.ts` — Summarizer unit tests
- `tests/server/context-api.test.ts` — Context endpoint integration tests

### Modified files
- `core/graph/db.ts` — Add `summaries` table migration
- `core/graph/index.ts` — Add `getSummary()`, `upsertSummary()`, `getMessagesForThread()` methods
- `core/graph/schema.ts` — Add `SummaryRow` type
- `core/server.ts` — Add `GET /api/work-item/:id/context` endpoint
- `core/adapters/platforms/interface.ts` — Add `getThreadMessages(threadId, channelId)` method
- `core/adapters/platforms/slack/index.ts` — Implement `getThreadMessages`
- `core/adapters/tasks/interface.ts` — Add `getComments(id)` method
- `core/adapters/tasks/jira/index.ts` — Implement `getComments`
- `core/config.ts` — Add `quickReplies` and `summarizer` to ConfigSchema
- `config/default.yaml` — Add `quickReplies` and `summarizer` config sections
- `src/components/WorkItemCard.tsx` — Add click handler to open pane
- `src/components/Inbox.tsx` — Manage selected work item state, render ContextPane
- `src/lib/api.ts` — Add `fetchWorkItemContext()` function + context types
- `src/App.tsx` — Pass context pane state through to Inbox

---

### Task 1: Summary Cache Schema

**Files:**
- Modify: `core/graph/db.ts`
- Modify: `core/graph/schema.ts`
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write the failing test — summaries table exists after init**

Add to `tests/graph/db.test.ts` inside the `describe("schema creation")` block:

```typescript
it("creates summaries table", () => {
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  expect(names).toContain("summaries");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/db.test.ts -t "creates summaries table"`
Expected: FAIL — "summaries" not in table list

- [ ] **Step 3: Add SummaryRow type to schema.ts**

Add to `core/graph/schema.ts`:

```typescript
export interface SummaryRow {
  work_item_id: string;
  summary_text: string;
  generated_at: string;
  latest_event_id: string;
}
```

- [ ] **Step 4: Add summaries table to db.ts**

In `core/graph/db.ts`, add to the `SCHEMA_SQL` string, after the `poll_cursors` table:

```sql
CREATE TABLE IF NOT EXISTS summaries (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  summary_text TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  latest_event_id TEXT NOT NULL
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/graph/db.test.ts -t "creates summaries table"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/graph/db.ts core/graph/schema.ts tests/graph/db.test.ts
git commit -m "feat(graph): add summaries table for context pane cache"
```

---

### Task 2: ContextGraph Summary and Thread Message Methods

**Files:**
- Modify: `core/graph/index.ts`
- Test: `tests/graph/db.test.ts`

- [ ] **Step 1: Write failing tests for summary CRUD and getEventsForWorkItem ordering**

Add to `tests/graph/db.test.ts`:

```typescript
describe("summaries CRUD", () => {
  it("upserts and retrieves a summary", () => {
    graph.upsertWorkItem({ id: "AI-1", source: "jira" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-1",
      status: "in_progress",
      confidence: 0.9,
      timestamp: "2026-03-31T10:00:00Z",
    });

    const events = graph.getEventsForWorkItem("AI-1");
    const latestEventId = events[events.length - 1].id;

    graph.upsertSummary({
      workItemId: "AI-1",
      summaryText: "- Agent started work\n- Waiting for PR review",
      latestEventId,
    });

    const summary = graph.getSummary("AI-1");
    expect(summary).not.toBeNull();
    expect(summary!.summaryText).toContain("Agent started work");
    expect(summary!.latestEventId).toBe(latestEventId);
  });

  it("returns null for non-existent summary", () => {
    expect(graph.getSummary("NOPE-1")).toBeNull();
  });

  it("overwrites existing summary on upsert", () => {
    graph.upsertWorkItem({ id: "AI-1", source: "jira" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-1" });
    graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-1",
      status: "in_progress",
      confidence: 0.9,
      timestamp: "2026-03-31T10:00:00Z",
    });

    graph.upsertSummary({
      workItemId: "AI-1",
      summaryText: "Old summary",
      latestEventId: "evt-old",
    });
    graph.upsertSummary({
      workItemId: "AI-1",
      summaryText: "New summary",
      latestEventId: "evt-new",
    });

    const summary = graph.getSummary("AI-1");
    expect(summary!.summaryText).toBe("New summary");
    expect(summary!.latestEventId).toBe("evt-new");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph/db.test.ts -t "summaries CRUD"`
Expected: FAIL — `graph.upsertSummary is not a function`

- [ ] **Step 3: Implement summary methods in ContextGraph**

Add to `core/graph/index.ts`:

Import `SummaryRow` at the top:
```typescript
import type {
  AgentRow,
  EnrichmentRow,
  EventRow,
  PollCursorRow,
  SummaryRow,
  ThreadRow,
  WorkItemRow,
} from "./schema.js";
```

Add a mapper function after the existing mappers:
```typescript
function toSummary(row: SummaryRow): { workItemId: string; summaryText: string; generatedAt: string; latestEventId: string } {
  return {
    workItemId: row.work_item_id,
    summaryText: row.summary_text,
    generatedAt: row.generated_at,
    latestEventId: row.latest_event_id,
  };
}
```

Add methods to the `ContextGraph` class:
```typescript
// --- Summaries ---

getSummary(workItemId: string): { workItemId: string; summaryText: string; generatedAt: string; latestEventId: string } | null {
  const row = this.db.db
    .prepare("SELECT * FROM summaries WHERE work_item_id = ?")
    .get(workItemId) as SummaryRow | undefined;
  return row ? toSummary(row) : null;
}

upsertSummary(summary: {
  workItemId: string;
  summaryText: string;
  latestEventId: string;
}): void {
  const now = new Date().toISOString();
  this.db.db.prepare(`
    INSERT INTO summaries (work_item_id, summary_text, generated_at, latest_event_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      summary_text = excluded.summary_text,
      generated_at = excluded.generated_at,
      latest_event_id = excluded.latest_event_id
  `).run(summary.workItemId, summary.summaryText, now, summary.latestEventId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph/db.test.ts -t "summaries CRUD"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/index.ts tests/graph/db.test.ts
git commit -m "feat(graph): add summary CRUD methods to ContextGraph"
```

---

### Task 3: Platform Adapter — getThreadMessages

**Files:**
- Modify: `core/adapters/platforms/interface.ts`
- Modify: `core/adapters/platforms/slack/index.ts`
- Test: `tests/adapters/slack.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/slack.test.ts` (follow existing test patterns in that file — the tests mock `fetch` or the Slack WebClient):

```typescript
describe("getThreadMessages", () => {
  it("returns messages for a specific thread", async () => {
    // Mock the conversations.replies API call
    const mockReplies = {
      ok: true,
      messages: [
        { ts: "1711900000.000000", user: "U1", text: "Starting work on AI-382" },
        { ts: "1711900100.000000", user: "U2", text: "PR submitted for review" },
        { ts: "1711900200.000000", user: "U1", text: "Approved and merged" },
      ],
      response_metadata: {},
    };

    // Use the existing mock pattern from the test file
    const adapter = new SlackAdapter();
    // Connect with mocked client
    const mockClient = {
      auth: { test: vi.fn().mockResolvedValue({ user: "test", team: "test", url: "https://test.slack.com/" }) },
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
        replies: vi.fn().mockResolvedValue(mockReplies),
      },
      users: { list: vi.fn().mockResolvedValue({ members: [], response_metadata: {} }) },
    };
    (adapter as any).client = mockClient;
    (adapter as any).channelMap = new Map([["C123", { name: "test", isPrivate: false }]]);
    (adapter as any).userInfoMap = new Map([
      ["U1", { name: "Byte", avatar: "" }],
      ["U2", { name: "Pixel", avatar: "" }],
    ]);

    const messages = await adapter.getThreadMessages("1711900000.000000", "C123");

    expect(messages).toHaveLength(3);
    expect(messages[0].userName).toBe("Byte");
    expect(messages[0].text).toBe("Starting work on AI-382");
    expect(messages[2].text).toBe("Approved and merged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/slack.test.ts -t "getThreadMessages"`
Expected: FAIL — `adapter.getThreadMessages is not a function`

- [ ] **Step 3: Add getThreadMessages to PlatformAdapter interface**

In `core/adapters/platforms/interface.ts`, add to the interface:

```typescript
getThreadMessages(threadId: string, channelId: string): Promise<Message[]>;
```

- [ ] **Step 4: Implement getThreadMessages in SlackAdapter**

Add to `core/adapters/platforms/slack/index.ts` in the `SlackAdapter` class, after `getUsers()`:

```typescript
async getThreadMessages(threadId: string, channelId: string): Promise<Message[]> {
  this.ensureConnected();

  const channelInfo = this.channelMap.get(channelId);
  const channelName = channelInfo?.name ?? channelId;

  const slackMessages = await this.fetchThreadReplies(channelId, threadId);

  return slackMessages.map((msg) => {
    const userInfo = this.userInfoMap.get(msg.user ?? "");
    return {
      id: msg.ts ?? "",
      threadId,
      channelId,
      channelName,
      userId: msg.user ?? "",
      userName: userInfo?.name ?? msg.user ?? "unknown",
      userAvatarUrl: userInfo?.avatar || undefined,
      text: this.resolveSlackMentions(msg.text ?? ""),
      timestamp: msg.ts ? slackTsToISO(msg.ts) : "",
      platform: "slack",
    };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/adapters/slack.test.ts -t "getThreadMessages"`
Expected: PASS

- [ ] **Step 6: Run all existing slack adapter tests to check for regressions**

Run: `npx vitest run tests/adapters/slack.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add core/adapters/platforms/interface.ts core/adapters/platforms/slack/index.ts tests/adapters/slack.test.ts
git commit -m "feat(slack): add getThreadMessages to PlatformAdapter interface"
```

---

### Task 4: Task Adapter — getComments

**Files:**
- Modify: `core/adapters/tasks/interface.ts`
- Modify: `core/adapters/tasks/jira/index.ts`
- Test: `tests/adapters/jira.test.ts`

- [ ] **Step 1: Add Comment type to core/types.ts**

Add to `core/types.ts`:

```typescript
export interface WorkItemComment {
  id: string;
  author: string;
  body: string;
  created: string;
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/adapters/jira.test.ts`:

```typescript
describe("getComments", () => {
  it("fetches and returns comments for a Jira issue", async () => {
    const mockResponse = {
      comments: [
        {
          id: "10001",
          author: { displayName: "Alice" },
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good to me" }] }] },
          created: "2026-03-31T10:00:00.000+0000",
        },
        {
          id: "10002",
          author: { displayName: "Bob" },
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }] },
          created: "2026-03-31T11:00:00.000+0000",
        },
      ],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // First call: connect (myself endpoint)
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ displayName: "Test User" }), { status: 200 }),
    );
    // Second call: getComments
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const adapter = new JiraAdapter();
    await adapter.connect({ token: "dGVzdDp0ZXN0", baseUrl: "https://test.atlassian.net" });
    const comments = await adapter.getComments("AI-382");

    expect(comments).toHaveLength(2);
    expect(comments[0].author).toBe("Alice");
    expect(comments[0].body).toBe("Looks good to me");
    expect(comments[1].author).toBe("Bob");

    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/adapters/jira.test.ts -t "getComments"`
Expected: FAIL — `adapter.getComments is not a function`

- [ ] **Step 4: Add getComments to TaskAdapter interface**

In `core/adapters/tasks/interface.ts`, add the import and method:

```typescript
import type { Credentials, WorkItemDetail, WorkItemComment } from "../../types.js";

export interface TaskAdapter {
  name: string;
  connect(credentials: Credentials): Promise<void>;
  getWorkItem(id: string): Promise<WorkItemDetail | null>;
  updateWorkItem(id: string, update: Partial<WorkItemDetail>): Promise<void>;
  searchWorkItems(query: string): Promise<WorkItemDetail[]>;
  getComments(id: string): Promise<WorkItemComment[]>;
}
```

- [ ] **Step 5: Implement getComments in JiraAdapter**

Add to `core/adapters/tasks/jira/index.ts`:

Import the type at the top:
```typescript
import type { Credentials, WorkItemDetail, WorkItemComment } from "../../../types.js";
```

Add the method to the `JiraAdapter` class:

```typescript
async getComments(id: string): Promise<WorkItemComment[]> {
  this.ensureConnected();

  const response = await this.request(
    `/rest/api/3/issue/${encodeURIComponent(id)}/comment?orderBy=created&maxResults=5`,
  );

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get comments for ${id} (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    comments: Array<{
      id: string;
      author: { displayName: string };
      body: unknown;
      created: string;
    }>;
  };

  return data.comments.map((c) => ({
    id: c.id,
    author: c.author.displayName,
    body: extractPlainText(c.body),
    created: c.created,
  }));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/adapters/jira.test.ts -t "getComments"`
Expected: PASS

- [ ] **Step 7: Run all Jira tests for regressions**

Run: `npx vitest run tests/adapters/jira.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add core/types.ts core/adapters/tasks/interface.ts core/adapters/tasks/jira/index.ts tests/adapters/jira.test.ts
git commit -m "feat(jira): add getComments to TaskAdapter interface"
```

---

### Task 5: Summarizer Module

**Files:**
- Create: `core/summarizer/index.ts`
- Create: `core/summarizer/prompt.ts`
- Test: `tests/summarizer/summarizer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/summarizer/summarizer.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Summarizer } from "../../core/summarizer/index.js";
import type { ModelProvider } from "../../core/classifier/providers/interface.js";
import type { Event } from "../../core/types.js";

function mockLLMProvider(response: string): ModelProvider {
  return {
    name: "mock",
    classify: vi.fn().mockResolvedValue({
      status: "noise",
      confidence: 0,
      reason: response,
      workItemIds: [],
    }),
  };
}

const sampleEvents: Event[] = [
  {
    id: "e1",
    threadId: "t1",
    messageId: "m1",
    workItemId: "AI-382",
    agentId: "a1",
    status: "in_progress",
    confidence: 0.9,
    reason: "Agent started work",
    rawText: "Starting work on AI-382. Will submit PR shortly.",
    timestamp: "2026-03-31T08:00:00Z",
    createdAt: "2026-03-31T08:00:00Z",
  },
  {
    id: "e2",
    threadId: "t1",
    messageId: "m2",
    workItemId: "AI-382",
    agentId: "a1",
    status: "blocked_on_human",
    confidence: 0.95,
    reason: "Agent needs approval",
    rawText: "PR #716 is ready for review. Need approval before merging.",
    timestamp: "2026-03-31T10:00:00Z",
    createdAt: "2026-03-31T10:00:00Z",
  },
];

describe("Summarizer", () => {
  it("generates a summary from events using the LLM", async () => {
    const summaryText = "- Agent started work on AI-382\n- PR #716 submitted, awaiting review\n- Currently blocked: needs human approval to merge";

    // The Summarizer uses the provider's raw text generation, not classify.
    // We mock the underlying fetch since Summarizer calls the provider directly.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ text: summaryText }],
        }),
        { status: 200 },
      ),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    const result = await summarizer.summarize(sampleEvents, "AI-382");

    expect(result).toContain("AI-382");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("returns a fallback summary when LLM call fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("API timeout"),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    const result = await summarizer.summarize(sampleEvents, "AI-382");

    expect(result).toContain("AI-382");
    // Should still return something useful from the event data
    expect(result.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("builds a prompt that includes event raw text and statuses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ text: "- Summary bullet" }],
        }),
        { status: 200 },
      ),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    await summarizer.summarize(sampleEvents, "AI-382");

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const userMessage = body.messages.find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toContain("AI-382");
    expect(userMessage.content).toContain("Starting work on AI-382");
    expect(userMessage.content).toContain("blocked_on_human");

    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summarizer/summarizer.test.ts`
Expected: FAIL — cannot find module `../../core/summarizer/index.js`

- [ ] **Step 3: Create the summarizer prompt**

Create `core/summarizer/prompt.ts`:

```typescript
export const SUMMARIZER_SYSTEM_PROMPT = `You are ATC, an assistant that summarizes agent conversation threads for a human operator.

Given a sequence of messages from an agent conversation thread, produce a concise summary as 3-5 bullet points. Each bullet should be one short sentence.

Focus on:
- What work was attempted or completed
- The current state (what's happening right now)
- What's blocking progress (if anything)
- Key decisions made or pending

Rules:
- Use plain language, no jargon
- Reference ticket IDs and PR numbers when mentioned
- Start each bullet with "- "
- Do NOT include timestamps
- Do NOT add commentary or suggestions — just summarize what happened`;

export function buildSummarizationPrompt(
  events: Array<{ rawText: string; status: string; timestamp: string }>,
  workItemId: string,
): string {
  const lines = events.map((e) =>
    `[${e.status}] ${e.rawText}`
  );

  return `Summarize this conversation thread for work item ${workItemId}:\n\n${lines.join("\n\n")}`;
}
```

- [ ] **Step 4: Create the Summarizer class**

Create `core/summarizer/index.ts`:

```typescript
import { createLogger } from "../logger.js";
import { SUMMARIZER_SYSTEM_PROMPT, buildSummarizationPrompt } from "./prompt.js";
import type { Event } from "../types.js";

const log = createLogger("summarizer");

export interface SummarizerConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class Summarizer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;

  constructor(config: SummarizerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
  }

  async summarize(events: Event[], workItemId: string): Promise<string> {
    if (events.length === 0) {
      return `No conversation history for ${workItemId}.`;
    }

    const userPrompt = buildSummarizationPrompt(events, workItemId);

    try {
      const summary = this.isAnthropic
        ? await this.callAnthropic(userPrompt)
        : await this.callOpenAI(userPrompt);
      return summary;
    } catch (error) {
      log.warn("Summarization failed, generating fallback", error);
      return this.fallbackSummary(events, workItemId);
    }
  }

  private async callAnthropic(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: SUMMARIZER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { content: Array<{ text: string }> };
    return json.content[0].text;
  }

  private async callOpenAI(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0].message.content;
  }

  private fallbackSummary(events: Event[], workItemId: string): string {
    const latest = events[events.length - 1];
    const statusCounts = new Map<string, number>();
    for (const e of events) {
      statusCounts.set(e.status, (statusCounts.get(e.status) ?? 0) + 1);
    }

    const lines = [
      `- Work item ${workItemId}: ${events.length} message(s) in thread`,
      `- Current status: ${latest.status}`,
      `- Latest: ${latest.rawText.slice(0, 150)}${latest.rawText.length > 150 ? "..." : ""}`,
    ];
    return lines.join("\n");
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/summarizer/summarizer.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add core/summarizer/index.ts core/summarizer/prompt.ts tests/summarizer/summarizer.test.ts
git commit -m "feat(summarizer): add LLM-powered thread summarization module"
```

---

### Task 6: Config — quickReplies and Summarizer Settings

**Files:**
- Modify: `core/config.ts`
- Modify: `config/default.yaml`
- Test: `tests/core/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/config.test.ts`:

```typescript
it("loads quickReplies config", () => {
  const config = loadConfig(projectRoot);
  expect(config.quickReplies).toBeDefined();
  expect(config.quickReplies.blocked_on_human).toBeInstanceOf(Array);
  expect(config.quickReplies.blocked_on_human.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/config.test.ts -t "loads quickReplies"`
Expected: FAIL — `quickReplies` not in schema

- [ ] **Step 3: Update ConfigSchema in config.ts**

Add to the `ConfigSchema` in `core/config.ts`, after the `server` field:

```typescript
quickReplies: z.record(z.string(), z.array(z.string())).optional().default({
  blocked_on_human: [
    "Approved, proceed",
    "Hold — waiting for my review",
    "Re-do with the following constraint:",
  ],
  needs_decision: [
    "Go with option A",
    "Go with option B",
    "Need more info before deciding",
  ],
}),
```

- [ ] **Step 4: Add quickReplies section to config/default.yaml**

Add to the end of `config/default.yaml`:

```yaml
quickReplies:
  blocked_on_human:
    - "Approved, proceed"
    - "Hold — waiting for my review"
    - "Re-do with the following constraint:"
  needs_decision:
    - "Go with option A"
    - "Go with option B"
    - "Need more info before deciding"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/config.test.ts -t "loads quickReplies"`
Expected: PASS

- [ ] **Step 6: Run all config tests for regressions**

Run: `npx vitest run tests/core/config.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add core/config.ts config/default.yaml tests/core/config.test.ts
git commit -m "feat(config): add quickReplies configuration for context pane"
```

---

### Task 7: Context API Endpoint

**Files:**
- Modify: `core/server.ts`
- Create: `tests/server/context-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/context-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifier = new Classifier(
    { name: "mock", classify: vi.fn() },
    "sys",
    [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] }),
  ]);
  return {
    config: {
      slack: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test", apiKey: "" }, confidenceThreshold: 0.6 },
      jira: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      quickReplies: {
        blocked_on_human: ["Approved, proceed", "Hold"],
        needs_decision: ["Option A", "Option B"],
      },
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
    ...overrides,
  };
}

describe("GET /api/work-item/:id/context", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    // Set up test data
    state.graph.upsertAgent({
      id: "a1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U1",
    });
    state.graph.upsertWorkItem({
      id: "AI-382",
      source: "jira",
      title: "Fix login bug",
      currentAtcStatus: "blocked_on_human",
      currentConfidence: 0.95,
    });
    state.graph.upsertThread({
      id: "t1",
      channelId: "C123",
      channelName: "agent-orchestrator",
      platform: "slack",
      workItemId: "AI-382",
      messageCount: 3,
    });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-382",
      agentId: "a1",
      status: "in_progress",
      confidence: 0.9,
      reason: "Agent started work",
      rawText: "Starting work on AI-382",
      timestamp: "2026-03-31T08:00:00Z",
    });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m2",
      workItemId: "AI-382",
      agentId: "a1",
      status: "blocked_on_human",
      confidence: 0.95,
      reason: "Needs approval",
      rawText: "PR ready, need approval",
      timestamp: "2026-03-31T10:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns context with events, enrichments, and quick replies", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/context");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.workItem.id).toBe("AI-382");
    expect(body.events).toHaveLength(2);
    expect(body.events[0].rawText).toBe("Starting work on AI-382");
    expect(body.threads).toHaveLength(1);
    expect(body.quickReplies).toBeInstanceOf(Array);
    expect(body.quickReplies.length).toBeGreaterThan(0);
  });

  it("returns 404 for non-existent work item", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/NOPE-1/context");
    expect(res.status).toBe(404);
  });

  it("includes enrichments when available", async () => {
    state.graph.upsertEnrichment({
      workItemId: "AI-382",
      source: "jira",
      data: { status: "In Review", description: "Fix the login redirect bug" },
    });

    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/context");
    const body = await res.json();

    expect(body.enrichments).toHaveLength(1);
    expect(body.enrichments[0].data.status).toBe("In Review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/context-api.test.ts`
Expected: FAIL — route not found (404 on the context endpoint)

- [ ] **Step 3: Add the context endpoint to server.ts**

In `core/server.ts`, add after the `GET /api/work-item/:id` route:

```typescript
// --- GET /api/work-item/:id/context ---
app.get("/api/work-item/:id/context", async (c) => {
  const id = c.req.param("id");
  const workItem = state.graph.getWorkItemById(id);
  if (!workItem) {
    return c.json({ error: "Work item not found" }, 404);
  }

  const threads = state.graph.getThreadsForWorkItem(id);
  const events = state.graph.getEventsForWorkItem(id);
  const enrichments = state.graph.getEnrichmentsForWorkItem(id);

  // Determine quick replies based on work item status
  const quickReplies: string[] =
    (state.config as any).quickReplies?.[workItem.currentAtcStatus ?? ""] ?? [];

  // Summary: check cache, generate if stale
  let summary: string | null = null;
  const cached = state.graph.getSummary(id);
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  if (cached && latestEvent && cached.latestEventId === latestEvent.id) {
    summary = cached.summaryText;
  }
  // Note: summary generation (LLM call) is handled by a separate POST endpoint
  // or the frontend can call it on demand. For now we return cached or null.

  return c.json({
    workItem,
    threads,
    events,
    enrichments,
    quickReplies,
    summary,
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/context-api.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Run all server-related tests for regressions**

Run: `npx vitest run tests/`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add core/server.ts tests/server/context-api.test.ts
git commit -m "feat(server): add GET /api/work-item/:id/context endpoint"
```

---

### Task 8: Summary Generation Endpoint

**Files:**
- Modify: `core/server.ts`
- Modify: `tests/server/context-api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/server/context-api.test.ts`:

```typescript
describe("POST /api/work-item/:id/summarize", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    state.graph.upsertWorkItem({ id: "AI-382", source: "jira", title: "Fix login", currentAtcStatus: "blocked_on_human" });
    state.graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-382" });
    state.graph.insertEvent({
      threadId: "t1",
      messageId: "m1",
      workItemId: "AI-382",
      agentId: "a1",
      status: "blocked_on_human",
      confidence: 0.95,
      rawText: "Need approval for PR",
      timestamp: "2026-03-31T10:00:00Z",
    });
  });

  afterEach(() => {
    state.db.close();
  });

  it("generates and caches a summary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ text: "- PR needs approval\n- Agent blocked" }] }),
        { status: 200 },
      ),
    );

    const app = createApp(state);
    const res = await app.request("/api/work-item/AI-382/summarize", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("PR needs approval");

    // Verify it was cached
    const cached = state.graph.getSummary("AI-382");
    expect(cached).not.toBeNull();
    expect(cached!.summaryText).toContain("PR needs approval");

    fetchSpy.mockRestore();
  });

  it("returns 404 for non-existent work item", async () => {
    const app = createApp(state);
    const res = await app.request("/api/work-item/NOPE-1/summarize", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/context-api.test.ts -t "POST /api/work-item"`
Expected: FAIL — 404 (route not found)

- [ ] **Step 3: Add summarizer to EngineState and the endpoint**

In `core/server.ts`, add the import:
```typescript
import { Summarizer } from "./summarizer/index.js";
```

Add to `EngineState`:
```typescript
summarizer: Summarizer | null;
```

Add the endpoint after the context endpoint:
```typescript
// --- POST /api/work-item/:id/summarize ---
app.post("/api/work-item/:id/summarize", async (c) => {
  const id = c.req.param("id");
  const workItem = state.graph.getWorkItemById(id);
  if (!workItem) {
    return c.json({ error: "Work item not found" }, 404);
  }

  const events = state.graph.getEventsForWorkItem(id);
  if (events.length === 0) {
    return c.json({ summary: `No conversation history for ${id}.` });
  }

  // Create summarizer on demand from classifier config
  const { baseUrl, model, apiKey } = state.config.classifier.provider;
  const summarizer = new Summarizer({ baseUrl, model, apiKey });

  const summary = await summarizer.summarize(events, id);

  // Cache it
  const latestEvent = events[events.length - 1];
  state.graph.upsertSummary({
    workItemId: id,
    summaryText: summary,
    latestEventId: latestEvent.id,
  });

  return c.json({ summary });
});
```

Also update the `main()` function to initialize `summarizer: null` in the state object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/context-api.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/server/context-api.test.ts
git commit -m "feat(server): add POST /api/work-item/:id/summarize endpoint"
```

---

### Task 9: Frontend API — Context Types and Fetch Functions

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add context types and fetch functions to api.ts**

Add to `src/lib/api.ts`:

After the existing type definitions, add:

```typescript
export interface WorkItemComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface Enrichment {
  id: string;
  workItemId: string;
  source: string;
  data: Record<string, unknown>;
  fetchedAt: string;
}

export interface WorkItemContext {
  workItem: WorkItem;
  threads: Thread[];
  events: LatestEvent[];
  enrichments: Enrichment[];
  quickReplies: string[];
  summary: string | null;
}
```

Add after the existing API functions:

```typescript
export function fetchWorkItemContext(id: string): Promise<WorkItemContext> {
  return apiFetch(`/api/work-item/${encodeURIComponent(id)}/context`);
}

export function generateSummary(id: string): Promise<{ summary: string }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(id)}/summarize`, {
    method: "POST",
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add fetchWorkItemContext and generateSummary API functions"
```

---

### Task 10: ContextPane React Component

**Files:**
- Create: `src/components/ContextPane.tsx`

- [ ] **Step 1: Create the ContextPane component**

Create `src/components/ContextPane.tsx`:

```tsx
import { useState, useEffect, useCallback, useRef, type JSX } from "react";
import {
  fetchWorkItemContext,
  generateSummary,
  postAction,
  postReply,
  type WorkItemContext,
  type Mentionable,
} from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import MentionInput from "./MentionInput";
import MessageRenderer from "../platforms/MessageRenderer";

interface ContextPaneProps {
  workItemId: string;
  platformMeta?: Record<string, unknown>;
  userMap: Map<string, string>;
  mentionables: Mentionable[];
  onClose: () => void;
  onActioned?: () => void;
}

export default function ContextPane({
  workItemId,
  platformMeta,
  userMap,
  mentionables,
  onClose,
  onActioned,
}: ContextPaneProps): JSX.Element {
  const [context, setContext] = useState<WorkItemContext | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  // Fetch context on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const ctx = await fetchWorkItemContext(workItemId);
        if (!cancelled) {
          setContext(ctx);
          setSummary(ctx.summary);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load context");
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workItemId]);

  // Auto-generate summary if not cached
  useEffect(() => {
    if (context && !summary && !summarizing) {
      setSummarizing(true);
      generateSummary(workItemId)
        .then((res) => setSummary(res.summary))
        .catch(() => setSummary("Summary unavailable"))
        .finally(() => setSummarizing(false));
    }
  }, [context, summary, summarizing, workItemId]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Close on click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  async function handleQuickReply(text: string) {
    if (!context?.threads[0]) return;
    setActing(true);
    try {
      const thread = context.threads[0];
      await postReply(thread.id, thread.channelId, text);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setActing(false);
    }
  }

  async function handleReplySubmit(serializedText: string) {
    if (!context?.threads[0] || !serializedText) return;
    setActing(true);
    try {
      const thread = context.threads[0];
      await postReply(thread.id, thread.channelId, serializedText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setActing(false);
    }
  }

  // Loading state
  if (!context && !error) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6 overflow-y-auto animate-slide-in-right">
          <div className="flex items-center justify-between mb-6">
            <div className="h-5 w-32 bg-gray-800 rounded animate-pulse" />
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">✕</button>
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

  if (error && !context) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6">
          <div className="flex items-center justify-between mb-6">
            <span className="text-sm text-red-400">{error}</span>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">✕</button>
          </div>
        </div>
      </div>
    );
  }

  if (!context) return <></>;

  const { workItem, events, enrichments, quickReplies, threads } = context;
  const jiraEnrichment = enrichments.find((e) => e.source === "jira");
  const thread = threads[0];
  const serializeMention = thread?.platform === "slack"
    ? (id: string, name: string) => `<@${id}>`
    : (id: string) => `@${id}`;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
      <div
        ref={paneRef}
        className="w-full max-w-xl bg-gray-950 border-l border-gray-800 overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-950 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold text-blue-400">
                {workItem.id}
              </span>
              <StatusBadge status={workItem.currentAtcStatus ?? "noise"} />
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer text-lg">✕</button>
          </div>
          {workItem.title && (
            <p className="mt-1 text-sm text-gray-300">{workItem.title}</p>
          )}
          {workItem.externalStatus && (
            <p className="mt-0.5 text-xs text-gray-500">
              Jira: {workItem.externalStatus}
              {workItem.assignee && ` · ${workItem.assignee}`}
            </p>
          )}
        </div>

        <div className="px-6 py-4 space-y-6">
          {/* AI Summary */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Summary
            </h3>
            {summarizing ? (
              <div className="text-sm text-gray-500 animate-pulse">Generating summary...</div>
            ) : summary ? (
              <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {summary}
              </div>
            ) : (
              <div className="text-sm text-gray-500">No summary available</div>
            )}
          </section>

          {/* Jira Context */}
          {jiraEnrichment && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Jira
              </h3>
              <div className="rounded border border-gray-800 bg-gray-900 p-3 text-sm space-y-1">
                {(jiraEnrichment.data as any).description && (
                  <p className="text-gray-300">
                    {String((jiraEnrichment.data as any).description).slice(0, 500)}
                  </p>
                )}
                {(jiraEnrichment.data as any).status && (
                  <p className="text-xs text-gray-500">
                    Status: {String((jiraEnrichment.data as any).status)}
                  </p>
                )}
                {(jiraEnrichment.data as any).labels?.length > 0 && (
                  <p className="text-xs text-gray-500">
                    Labels: {((jiraEnrichment.data as any).labels as string[]).join(", ")}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Conversation Thread */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Conversation ({events.length} messages)
            </h3>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {events.map((evt) => {
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

          {/* Quick Replies */}
          {quickReplies.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Quick Replies
              </h3>
              <div className="flex flex-wrap gap-2">
                {quickReplies.map((reply) => (
                  <button
                    key={reply}
                    onClick={() => handleQuickReply(reply)}
                    disabled={acting}
                    className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800 hover:border-gray-600 disabled:opacity-40"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Reply Input */}
          {thread && (
            <section>
              <MentionInput
                placeholder="Reply to thread..."
                disabled={acting}
                mentionables={mentionables}
                serializeMention={serializeMention}
                onSubmit={handleReplySubmit}
              />
            </section>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
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
git add src/components/ContextPane.tsx
git commit -m "feat(ui): add ContextPane slide-out component"
```

---

### Task 11: Wire ContextPane into Inbox and WorkItemCard

**Files:**
- Modify: `src/components/Inbox.tsx`
- Modify: `src/components/WorkItemCard.tsx`

- [ ] **Step 1: Add selectedWorkItemId state to Inbox and render ContextPane**

In `src/components/Inbox.tsx`, add the import:
```typescript
import ContextPane from "./ContextPane";
```

Add state after the existing state declarations:
```typescript
const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
```

Add the `onSelect` handler:
```typescript
const handleSelect = useCallback((workItemId: string) => {
  setSelectedWorkItemId((prev) => (prev === workItemId ? null : workItemId));
}, []);
```

Pass `onSelect` to each `WorkItemCard`:
```tsx
<WorkItemCard
  key={item.workItem.id + item.latestEvent.id}
  item={item}
  platformMeta={platformMeta}
  userMap={userMap}
  mentionables={mentionables}
  onActioned={handleActioned}
  onSelect={handleSelect}
/>
```

Add the ContextPane render at the end of the return, before the closing `</div>`:
```tsx
{selectedWorkItemId && (
  <ContextPane
    workItemId={selectedWorkItemId}
    platformMeta={platformMeta}
    userMap={userMap}
    mentionables={mentionables}
    onClose={() => setSelectedWorkItemId(null)}
    onActioned={handleActioned}
  />
)}
```

- [ ] **Step 2: Add onSelect prop and click handler to WorkItemCard**

In `src/components/WorkItemCard.tsx`, add to the interface:
```typescript
onSelect?: (workItemId: string) => void;
```

Update the destructuring:
```typescript
export default function WorkItemCard({ item, platformMeta, userMap, mentionables, onActioned, onSelect }: WorkItemCardProps): JSX.Element {
```

Make the card clickable by wrapping the top row div with an onClick handler. Change the outer div of the card:
```tsx
<div
  className="rounded border border-gray-800 bg-gray-900 p-4 cursor-pointer hover:border-gray-700 transition-colors"
  onClick={() => onSelect?.(workItem.id)}
>
```

Add `e.stopPropagation()` to the action buttons and reply input click handlers to prevent the card click from firing when interacting with actions. Add to `handleAction`:
```typescript
// In the button onClick:
onClick={(e) => { e.stopPropagation(); handleAction(action); }}
```

And wrap the reply/actions section at the bottom in a div with stopPropagation:
```tsx
<div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
```

- [ ] **Step 3: Verify the app compiles and renders**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/components/Inbox.tsx src/components/WorkItemCard.tsx
git commit -m "feat(ui): wire ContextPane into Inbox — click work item to open detail pane"
```

---

### Task 12: Slide-in Animation CSS

**Files:**
- Modify: `src/index.css` (or wherever Tailwind base styles are)

- [ ] **Step 1: Add the slide-in-right animation**

Find the Tailwind CSS file and add:

```css
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

.animate-slide-in-right {
  animation: slide-in-right 0.2s ease-out;
}
```

- [ ] **Step 2: Verify the animation class is available**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat(ui): add slide-in-right animation for context pane"
```

---

### Task 13: End-to-End Verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Start the dev server and visually verify**

Run: `npm run dev:web`
Open http://localhost:5173 in a browser. Verify:
- Work item cards are clickable
- Clicking opens the context pane from the right
- Pane shows summary (or loading state), events, quick replies
- Escape closes the pane
- Quick reply chips are clickable
- Reply input works

- [ ] **Step 3: Fix any issues found during visual verification**

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: context pane polish and integration fixes"
```
