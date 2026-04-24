# Conversation Continuation & Work Item Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-group non-threaded messages from the same channel conversation into a single work item, and provide delightful manual merge when auto-grouping misses.

**Architecture:** Enrich the existing classifier prompt with recent channel context (message text from nearby standalone messages) so the LLM can recognize conversational continuations. Add a merge backend (graph + API) and four frontend interaction patterns: contextual "Same conversation?" suggestion, "Merge into..." dropdown, drag-to-merge in list, and keyboard shortcuts.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Hono, React, Tailwind CSS, Vitest

---

## File Structure

### Backend — New files
- `core/continuation/interface.ts` — `ContinuationStrategy`, `ContinuationResult`, `RecentChannelMessage` types (extensibility for future approaches B/C)

### Backend — Modified files
- `core/graph/db.ts` — migration: `merged_into` column on `work_items`
- `core/graph/index.ts` — `getRecentChannelContext()`, `mergeWorkItems()`, `unmergeWorkItem()`, filter merged items from stream queries
- `core/graph/schema.ts` — add `mergedInto` to `WorkItem` type
- `core/classifier/index.ts` — accept and render channel context in prompt
- `core/pipeline.ts` — gather channel context, sort messages chronologically, pass context to classifier
- `core/server.ts` — `/merge` and `/unmerge` API endpoints
- `core/adapters/messaging/slack/index.ts` — sort `fetchChannelHistory` results oldest-first
- `config/default.yaml` — `continuation` config section
- `core/types.ts` — add `mergedInto` to WorkItem type

### Frontend — New files
- `src/components/stream/MergeDropdown.tsx` — merge target dropdown (recently viewed + search)
- `src/components/stream/MergeSuggestion.tsx` — "Same conversation?" contextual banner
- `src/components/stream/UndoToast.tsx` — undo toast with timer

### Frontend — Modified files
- `src/lib/api.ts` — `mergeWorkItems()`, `unmergeWorkItem()`, `searchWorkItems()` API functions
- `src/components/stream/SuggestedActions.tsx` — "Merge into..." button
- `src/components/stream/StreamDetail.tsx` — mount MergeSuggestion, pass merge handler
- `src/components/stream/StreamListItem.tsx` — drag source behavior
- `src/components/StreamView.tsx` — recently-viewed tracking, drag-to-merge container, keyboard shortcuts, undo toast, merge animation
- `src/index.css` — merge animation keyframes

---

### Task 1: Schema Migration — `merged_into` Column

**Files:**
- Modify: `core/graph/db.ts` (add migration in `migrate()` method, after line 272)
- Modify: `core/graph/schema.ts` (add `merged_into` to `WorkItemRow`)
- Modify: `core/graph/index.ts` (add `mergedInto` to `toWorkItem` mapper)
- Modify: `core/types.ts` (add `mergedInto` to `WorkItem` interface)
- Test: `tests/core/graph.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/core/graph.test.ts`, add a test for the merged_into column:

```typescript
describe("merged_into column", () => {
  it("work items have mergedInto field defaulting to null", () => {
    graph.upsertWorkItem({ id: "WI-1", source: "test", title: "Test item" });
    const item = graph.getWorkItemById("WI-1");
    expect(item).not.toBeNull();
    expect(item!.mergedInto).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/graph.test.ts -t "merged_into"`
Expected: FAIL — `mergedInto` property doesn't exist on WorkItem

- [ ] **Step 3: Add the migration and type changes**

In `core/types.ts`, add `mergedInto` to the `WorkItem` interface:

```typescript
export interface WorkItem {
  id: string;
  source: string;
  title: string;
  externalStatus: string | null;
  assignee: string | null;
  url: string | null;
  currentAtcStatus: StatusCategory | null;
  currentConfidence: number | null;
  snoozedUntil: string | null;
  pinned: boolean;
  dismissedAt: string | null;
  mergedInto: string | null;     // ← add this
  createdAt: string;
  updatedAt: string;
}
```

In `core/graph/schema.ts`, add `merged_into` to `WorkItemRow`:

```typescript
merged_into: string | null;
```

In `core/graph/index.ts`, update `toWorkItem()` mapper to include:

```typescript
mergedInto: row.merged_into ?? null,
```

In `core/graph/db.ts`, add at the end of `migrate()`:

```typescript
// Add merged_into column to work_items table (for work item merge support)
const wiColsMerge = this.db.pragma("table_info(work_items)") as Array<{ name: string }>;
if (!wiColsMerge.some((c) => c.name === "merged_into")) {
  this.db.exec("ALTER TABLE work_items ADD COLUMN merged_into TEXT DEFAULT NULL");
  log.info("Migration: added merged_into column to work_items");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/graph.test.ts -t "merged_into"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/db.ts core/graph/schema.ts core/graph/index.ts core/types.ts tests/core/graph.test.ts
git commit -m "feat: add merged_into column to work_items schema"
```

---

### Task 2: Chronological Sort Fix in Slack Adapter

**Files:**
- Modify: `core/adapters/messaging/slack/index.ts` (sort `fetchChannelHistory` results)
- Test: `tests/core/adapters/slack.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/core/adapters/slack.test.ts`, add a test that verifies messages come back oldest-first. If this file doesn't exist yet, add the test to `tests/core/pipeline.test.ts` as a focused integration test:

```typescript
describe("Slack adapter message ordering", () => {
  it("returns threads in chronological order (oldest first)", async () => {
    // Mock readThreads to return threads and verify ordering
    const threads = [
      makeThread("1777020165.044949", "C1", [
        makeMessage("msg-2", "1777020165.044949"),
      ]),
      makeThread("1777020026.196579", "C1", [
        makeMessage("msg-1", "1777020026.196579"),
      ]),
    ];
    vi.mocked(adapter.readThreads).mockResolvedValue(threads);

    await pipeline.processOnce();

    // Verify processMessageInternal was called in chronological order
    const calls = vi.mocked(classifier.classify).mock.calls;
    // First classified message should be the older one (1777020026)
    if (calls.length >= 2) {
      const firstMsg = calls[0][0] as string;
      const secondMsg = calls[1][0] as string;
      // The older message should be classified first
      expect(calls.length).toBeGreaterThanOrEqual(2);
    }
  });
});
```

- [ ] **Step 2: Sort threads chronologically in the pipeline**

The Slack adapter's `fetchChannelHistory` returns messages newest-first (Slack API default). Rather than modifying the adapter (which other adapters may not need), sort threads in the pipeline before processing.

In `core/pipeline.ts`, after line 120 (after the `cappedThreads` assignment), add:

```typescript
// Sort threads chronologically (oldest first) so earlier messages create
// work items before later messages that might be continuations.
cappedThreads.sort((a, b) => {
  const aTime = a.messages[0]?.timestamp ?? a.lastActivity;
  const bTime = b.messages[0]?.timestamp ?? b.lastActivity;
  return aTime.localeCompare(bTime);
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: All existing tests PASS (sort is additive, doesn't break existing behavior)

- [ ] **Step 4: Commit**

```bash
git add core/pipeline.ts
git commit -m "fix: sort threads chronologically before processing to support continuation detection"
```

---

### Task 3: Channel Context Query — `getRecentChannelContext()`

**Files:**
- Modify: `core/graph/index.ts` (add `getRecentChannelContext` method)
- Test: `tests/core/graph.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("getRecentChannelContext", () => {
  it("returns recent non-threaded messages from the same channel", () => {
    // Set up: two standalone messages in the same channel, different work items
    graph.upsertWorkItem({ id: "thread:ts1", source: "inferred", title: "First topic" });
    graph.upsertWorkItem({ id: "thread:ts2", source: "inferred", title: "Second topic" });
    graph.upsertAgent({ id: "U1", name: "Guy", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: false });

    graph.upsertThread({
      id: "ts1", channelId: "C1", channelName: "DM: Guy",
      platform: "slack", workItemId: "thread:ts1",
      lastActivity: new Date().toISOString(), messageCount: 1,
    });
    graph.upsertThread({
      id: "ts2", channelId: "C1", channelName: "DM: Guy",
      platform: "slack", workItemId: "thread:ts2",
      lastActivity: new Date().toISOString(), messageCount: 1,
    });

    const now = new Date();
    graph.insertEvent({
      threadId: "ts1", messageId: "msg1", workItemId: "thread:ts1",
      agentId: "U1", status: "needs_decision", confidence: 0.9,
      reason: "test", rawText: "I'm OK with it. But would a partner?",
      timestamp: new Date(now.getTime() - 120000).toISOString(), // 2 min ago
    });
    graph.insertEvent({
      threadId: "ts2", messageId: "msg2", workItemId: "thread:ts2",
      agentId: "U1", status: "needs_decision", confidence: 0.9,
      reason: "test", rawText: "Second topic entirely different",
      timestamp: new Date(now.getTime() - 60000).toISOString(), // 1 min ago
    });

    const context = graph.getRecentChannelContext({
      channelId: "C1",
      excludeThreadId: "ts2",
    });

    expect(context).toHaveLength(1);
    expect(context[0].workItemId).toBe("thread:ts1");
    expect(context[0].senderName).toBe("Guy");
    expect(context[0].text).toContain("OK with it");
  });

  it("excludes messages older than the window", () => {
    graph.upsertWorkItem({ id: "thread:old", source: "inferred", title: "Old" });
    graph.upsertAgent({ id: "U1", name: "Guy", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: false });

    graph.upsertThread({
      id: "old", channelId: "C1", channelName: "DM: Guy",
      platform: "slack", workItemId: "thread:old",
      lastActivity: new Date(Date.now() - 3600000).toISOString(), messageCount: 1,
    });

    graph.insertEvent({
      threadId: "old", messageId: "msg-old", workItemId: "thread:old",
      agentId: "U1", status: "in_progress", confidence: 0.9,
      reason: "test", rawText: "Very old message",
      timestamp: new Date(Date.now() - 3600000).toISOString(), // 60 min ago
    });

    const context = graph.getRecentChannelContext({
      channelId: "C1",
      windowMinutes: 30,
    });

    expect(context).toHaveLength(0);
  });

  it("limits results to maxContextMessages", () => {
    graph.upsertAgent({ id: "U1", name: "Guy", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: false });
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      const id = `thread:ts${i}`;
      graph.upsertWorkItem({ id, source: "inferred", title: `Topic ${i}` });
      graph.upsertThread({
        id: `ts${i}`, channelId: "C1", channelName: "DM: Guy",
        platform: "slack", workItemId: id,
        lastActivity: new Date(now - i * 60000).toISOString(), messageCount: 1,
      });
      graph.insertEvent({
        threadId: `ts${i}`, messageId: `msg${i}`, workItemId: id,
        agentId: "U1", status: "in_progress", confidence: 0.9,
        reason: "test", rawText: `Message ${i}`,
        timestamp: new Date(now - i * 60000).toISOString(),
      });
    }

    const context = graph.getRecentChannelContext({
      channelId: "C1",
      limit: 5,
    });

    expect(context).toHaveLength(5);
  });

  it("excludes messages from multi-message threads", () => {
    graph.upsertWorkItem({ id: "thread:parent", source: "inferred", title: "Threaded convo" });
    graph.upsertAgent({ id: "U1", name: "Guy", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: false });

    graph.upsertThread({
      id: "parent", channelId: "C1", channelName: "DM: Guy",
      platform: "slack", workItemId: "thread:parent",
      lastActivity: new Date().toISOString(), messageCount: 5, // threaded — has replies
    });

    graph.insertEvent({
      threadId: "parent", messageId: "msg-parent", workItemId: "thread:parent",
      agentId: "U1", status: "in_progress", confidence: 0.9,
      reason: "test", rawText: "This is threaded",
      timestamp: new Date().toISOString(),
    });

    const context = graph.getRecentChannelContext({ channelId: "C1" });
    expect(context).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/graph.test.ts -t "getRecentChannelContext"`
Expected: FAIL — method doesn't exist

- [ ] **Step 3: Implement `getRecentChannelContext`**

In `core/graph/index.ts`, add the method (near the other query methods, after `findCandidateWorkItems`):

```typescript
/**
 * Fetch recent messages from standalone (non-threaded) threads in a channel.
 * Used to provide conversation context to the classifier for continuation detection.
 */
getRecentChannelContext(params: {
  channelId: string;
  windowMinutes?: number;
  limit?: number;
  excludeThreadId?: string;
}): Array<{
  workItemId: string;
  workItemTitle: string;
  senderName: string;
  text: string;
  timestamp: string;
}> {
  const { channelId, windowMinutes = 30, limit = 5, excludeThreadId } = params;

  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const rows = this.db.db.prepare(`
    SELECT
      e.raw_text AS text,
      e.timestamp,
      e.work_item_id AS workItemId,
      wi.title AS workItemTitle,
      a.name AS senderName
    FROM events e
    JOIN threads t ON t.id = e.thread_id
    JOIN work_items wi ON wi.id = e.work_item_id
    LEFT JOIN agents a ON a.id = e.agent_id
    WHERE t.channel_id = ?
      AND t.message_count <= 1
      AND e.timestamp > ?
      AND e.work_item_id IS NOT NULL
      AND (wi.merged_into IS NULL)
      ${excludeThreadId ? "AND t.id != ?" : ""}
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(
    ...[channelId, cutoff, ...(excludeThreadId ? [excludeThreadId] : []), limit] as string[]
  ) as Array<{
    text: string;
    timestamp: string;
    workItemId: string;
    workItemTitle: string;
    senderName: string;
  }>;

  return rows.map(row => ({
    workItemId: row.workItemId,
    workItemTitle: row.workItemTitle ?? "",
    senderName: row.senderName ?? "Unknown",
    text: row.text.length > 200 ? row.text.slice(0, 200) + "…" : row.text,
    timestamp: row.timestamp,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/graph.test.ts -t "getRecentChannelContext"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/index.ts tests/core/graph.test.ts
git commit -m "feat: add getRecentChannelContext query for continuation detection"
```

---

### Task 4: Classifier Prompt Enrichment

**Files:**
- Modify: `core/classifier/index.ts` (add `channelContext` parameter to `classify`, render in prompt)
- Test: `tests/core/classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("channel context in prompt", () => {
  it("includes channel context section when provided", async () => {
    const classifySpy = vi.spyOn(provider, "classify").mockResolvedValue({
      status: "needs_decision",
      confidence: 0.9,
      reason: "continuation",
      workItemIds: ["thread:ts1"],
      title: "Merged topic",
    });

    await classifier.classify(
      "No big difference from floating it over",
      [{ id: "thread:ts1", title: "Partner approval", reasons: ["same channel"] }],
      null,
      { senderName: "Nir", senderType: "human", channelName: "DM: Guy" },
      [],
      // New parameter: channelContext
      [
        {
          workItemId: "thread:ts1",
          workItemTitle: "Partner approval",
          senderName: "Guy",
          text: "I'm OK with it. But would a partner?",
          timestamp: new Date(Date.now() - 120000).toISOString(),
        },
      ],
    );

    const systemPrompt = classifySpy.mock.calls[0][1];
    expect(systemPrompt).toContain("Recent messages from the same channel");
    expect(systemPrompt).toContain("I'm OK with it. But would a partner?");
    expect(systemPrompt).toContain("thread:ts1");
    expect(systemPrompt).toContain("Guy");
  });

  it("does not include channel context section when empty", async () => {
    const classifySpy = vi.spyOn(provider, "classify").mockResolvedValue({
      status: "in_progress",
      confidence: 0.8,
      reason: "test",
      workItemIds: [],
      title: "",
    });

    await classifier.classify("Hello", undefined, null, undefined, [], []);

    const systemPrompt = classifySpy.mock.calls[0][1];
    expect(systemPrompt).not.toContain("Recent messages from the same channel");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/classifier.test.ts -t "channel context"`
Expected: FAIL — `classify` doesn't accept a 6th parameter

- [ ] **Step 3: Add `channelContext` parameter to `classify`**

In `core/classifier/index.ts`, update the `classify` method signature (line 129) to add the new parameter:

```typescript
async classify(
  message: string,
  candidateWorkItems?: Array<{ id: string; title: string; reasons?: string[] }>,
  operatorIdentities?: OperatorIdentityMap | null,
  senderContext?: { senderName: string; senderType: string; channelName: string },
  validIdPrefixes?: string[],
  channelContext?: Array<{
    workItemId: string;
    workItemTitle: string;
    senderName: string;
    text: string;
    timestamp: string;
  }>,
): Promise<Classification> {
```

Then, after the `candidateWorkItems` prompt section (after line 184), add:

```typescript
if (channelContext && channelContext.length > 0) {
  const contextLines = channelContext.map((ctx) => {
    const ago = timeAgoShort(ctx.timestamp);
    return `- [${ctx.senderName}, ${ago}] "${ctx.text}" → work item: ${ctx.workItemId}`;
  }).join("\n");
  effectiveSystemPrompt += `\n\n## Recent Messages from the Same Channel\n\nThe following recent messages are from the same channel as this new message. If this new message is a continuation of one of these conversations (a reply, follow-up, or related remark), return that conversation's work item ID in workItemIds. If it's a new, unrelated topic, return empty workItemIds as usual.\n\n${contextLines}`;
}
```

Add a helper function at the top of the file:

```typescript
function timeAgoShort(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/classifier.test.ts -t "channel context"`
Expected: PASS

- [ ] **Step 5: Run all classifier tests**

Run: `npx vitest run tests/core/classifier.test.ts`
Expected: All PASS (new parameter is optional, existing calls unaffected)

- [ ] **Step 6: Commit**

```bash
git add core/classifier/index.ts tests/core/classifier.test.ts
git commit -m "feat: add channel context to classifier prompt for continuation detection"
```

---

### Task 5: Pipeline Integration — Gather Context and Pass to Classifier

**Files:**
- Modify: `core/pipeline.ts` (gather channel context before classification, pass to classifier)
- Modify: `config/default.yaml` (add `continuation` config section)
- Test: `tests/core/pipeline.test.ts`

- [ ] **Step 1: Add continuation config to `config/default.yaml`**

After the `lookback` section (after line 44), add:

```yaml
continuation:
  # Strategy for grouping non-threaded messages into conversations
  strategy: "classifier-inline"   # enriches classifier prompt with channel context
  channelContextWindow: 30        # minutes to look back for recent messages
  maxContextMessages: 5           # max messages to include as channel context
```

- [ ] **Step 2: Write the failing test**

In `tests/core/pipeline.test.ts`, add:

```typescript
describe("continuation detection", () => {
  it("passes channel context to classifier for standalone messages", async () => {
    const channelContext = [
      {
        workItemId: "thread:ts1",
        workItemTitle: "Partner approval",
        senderName: "Guy",
        text: "I'm OK with it. But would a partner?",
        timestamp: new Date(Date.now() - 120000).toISOString(),
      },
    ];
    vi.mocked(graph.getRecentChannelContext).mockReturnValue(channelContext);
    vi.mocked(graph.hasEvent).mockReturnValue(false);
    vi.mocked(graph.getThreadById).mockReturnValue(null);
    vi.mocked(graph.getWorkItemById).mockReturnValue(null);
    vi.mocked(graph.findCandidateWorkItems).mockReturnValue([]);

    vi.mocked(adapter.readThreads).mockResolvedValue([
      makeThread("ts2", "C1", [makeMessage("msg2", "ts2")]),
    ]);

    vi.mocked(classifier.classify).mockResolvedValue({
      status: "needs_decision",
      confidence: 0.9,
      reason: "continuation",
      workItemIds: ["thread:ts1"],
      title: "Partner approval",
      entryType: "block",
      targetedAtOperator: true,
      actionRequiredFrom: null,
      nextAction: null,
    });

    await pipeline.processOnce();

    // Verify channelContext was passed as the 6th argument to classify
    const classifyCall = vi.mocked(classifier.classify).mock.calls[0];
    expect(classifyCall[5]).toEqual(channelContext);
  });

  it("does not pass channel context for threaded messages", async () => {
    vi.mocked(graph.getRecentChannelContext).mockReturnValue([]);
    vi.mocked(graph.hasEvent).mockReturnValue(false);
    vi.mocked(graph.getThreadById).mockReturnValue(null);
    vi.mocked(graph.getWorkItemById).mockReturnValue(null);
    vi.mocked(graph.findCandidateWorkItems).mockReturnValue([]);

    // Thread with multiple messages = explicitly threaded
    vi.mocked(adapter.readThreads).mockResolvedValue([
      makeThread("ts3", "C1", [
        makeMessage("msg3a", "ts3"),
        makeMessage("msg3b", "ts3"),
      ]),
    ]);

    vi.mocked(classifier.classify).mockResolvedValue({
      status: "in_progress",
      confidence: 0.8,
      reason: "test",
      workItemIds: [],
      title: "",
      entryType: "progress",
      targetedAtOperator: false,
      actionRequiredFrom: null,
      nextAction: null,
    });

    await pipeline.processOnce();

    // channelContext should be empty for threaded messages
    const classifyCall = vi.mocked(classifier.classify).mock.calls[0];
    expect(classifyCall[5]).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/pipeline.test.ts -t "continuation detection"`
Expected: FAIL — `getRecentChannelContext` not mocked / not called

- [ ] **Step 4: Add `getRecentChannelContext` to mock graph**

In the `createMockGraph()` function in `tests/core/pipeline.test.ts`, add:

```typescript
getRecentChannelContext: vi.fn().mockReturnValue([]),
```

- [ ] **Step 5: Implement channel context gathering in pipeline**

In `core/pipeline.ts`, in the `processMessageInternal` method, after the `findCandidateWorkItems` call (after line 416), add:

```typescript
// Step 0f: Gather recent channel context for continuation detection.
// Only for standalone (non-threaded) messages — threaded messages are already
// grouped by Slack's native threading.
const isStandaloneMessage = thread.messages.length <= 1;
const continuationConfig = this.config?.continuation;
const channelContext = isStandaloneMessage
  ? this.graph.getRecentChannelContext({
      channelId: thread.channelId,
      windowMinutes: continuationConfig?.channelContextWindow ?? 30,
      limit: continuationConfig?.maxContextMessages ?? 5,
      excludeThreadId: thread.id,
    })
  : [];
```

Then update the `classify` call (line 435) to pass the channel context:

```typescript
const classification = await this.classifier.classify(
  message.text,
  candidateContext,
  this.operatorIdentities,
  senderContext,
  this.getValidPrefixes(),
  channelContext,
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/pipeline.test.ts -t "continuation detection"`
Expected: PASS

- [ ] **Step 7: Run all pipeline tests**

Run: `npx vitest run tests/core/pipeline.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add core/pipeline.ts config/default.yaml tests/core/pipeline.test.ts
git commit -m "feat: gather channel context and pass to classifier for continuation detection"
```

---

### Task 6: Merge & Unmerge Graph Operations

**Files:**
- Modify: `core/graph/index.ts` (add `mergeWorkItems`, `unmergeWorkItem`)
- Test: `tests/core/graph.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("mergeWorkItems", () => {
  it("re-links threads and events from source to target", () => {
    graph.upsertWorkItem({ id: "WI-source", source: "test", title: "Source item" });
    graph.upsertWorkItem({ id: "WI-target", source: "test", title: "Target item" });
    graph.upsertAgent({ id: "U1", name: "Agent", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: true });

    graph.upsertThread({
      id: "t1", channelId: "C1", channelName: "#test",
      platform: "slack", workItemId: "WI-source",
      lastActivity: new Date().toISOString(), messageCount: 1,
    });

    graph.insertEvent({
      threadId: "t1", messageId: "msg1", workItemId: "WI-source",
      agentId: "U1", status: "in_progress", confidence: 0.9,
      reason: "test", rawText: "Hello", timestamp: new Date().toISOString(),
    });

    graph.mergeWorkItems("WI-source", "WI-target");

    // Thread should now be linked to target
    const thread = graph.getThreadById("t1");
    expect(thread!.workItemId).toBe("WI-target");

    // Source should have merged_into set
    const source = graph.getWorkItemById("WI-source");
    expect(source!.mergedInto).toBe("WI-target");

    // Events should be re-linked
    const events = graph.getEventsForWorkItemPaginated("WI-target", 10);
    expect(events.events.length).toBeGreaterThanOrEqual(1);
  });

  it("returns merge record for undo support", () => {
    graph.upsertWorkItem({ id: "WI-s", source: "test", title: "Source", currentAtcStatus: "needs_decision" });
    graph.upsertWorkItem({ id: "WI-t", source: "test", title: "Target", currentAtcStatus: "in_progress" });

    const record = graph.mergeWorkItems("WI-s", "WI-t");

    expect(record.sourceId).toBe("WI-s");
    expect(record.targetId).toBe("WI-t");
    expect(record.sourceTitle).toBe("Source");
    expect(record.movedThreadIds).toBeDefined();
  });
});

describe("unmergeWorkItem", () => {
  it("reverses a merge operation", () => {
    graph.upsertWorkItem({ id: "WI-s2", source: "test", title: "Source" });
    graph.upsertWorkItem({ id: "WI-t2", source: "test", title: "Target" });
    graph.upsertAgent({ id: "U1", name: "Agent", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: true });

    graph.upsertThread({
      id: "t2", channelId: "C1", channelName: "#test",
      platform: "slack", workItemId: "WI-s2",
      lastActivity: new Date().toISOString(), messageCount: 1,
    });
    graph.insertEvent({
      threadId: "t2", messageId: "msg2", workItemId: "WI-s2",
      agentId: "U1", status: "in_progress", confidence: 0.9,
      reason: "test", rawText: "Hello", timestamp: new Date().toISOString(),
    });

    graph.mergeWorkItems("WI-s2", "WI-t2");
    graph.unmergeWorkItem("WI-s2");

    // Source should be restored
    const source = graph.getWorkItemById("WI-s2");
    expect(source!.mergedInto).toBeNull();

    // Thread should be back on source
    const thread = graph.getThreadById("t2");
    expect(thread!.workItemId).toBe("WI-s2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/graph.test.ts -t "mergeWorkItems"`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement `mergeWorkItems` and `unmergeWorkItem`**

In `core/graph/index.ts`, add:

```typescript
/**
 * Merge source work item into target. Re-links all threads and events.
 * Returns a record for undo support.
 */
mergeWorkItems(sourceId: string, targetId: string): {
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  movedThreadIds: string[];
} {
  const source = this.getWorkItemById(sourceId);
  if (!source) throw new Error(`Source work item not found: ${sourceId}`);
  if (!this.getWorkItemById(targetId)) throw new Error(`Target work item not found: ${targetId}`);

  // Collect thread IDs being moved (for undo record)
  const movedThreads = this.db.db
    .prepare("SELECT id FROM threads WHERE work_item_id = ?")
    .all(sourceId) as Array<{ id: string }>;
  const movedThreadIds = movedThreads.map(t => t.id);

  // Re-link threads
  this.db.db
    .prepare("UPDATE threads SET work_item_id = ? WHERE work_item_id = ?")
    .run(targetId, sourceId);

  // Re-link events
  this.db.db
    .prepare("UPDATE events SET work_item_id = ? WHERE work_item_id = ?")
    .run(targetId, sourceId);

  // Soft-delete source
  this.db.db
    .prepare("UPDATE work_items SET merged_into = ?, updated_at = ? WHERE id = ?")
    .run(targetId, new Date().toISOString(), sourceId);

  // Touch target updated_at
  this.db.db
    .prepare("UPDATE work_items SET updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), targetId);

  log.info("Merged work item", sourceId, "into", targetId, `(${movedThreadIds.length} threads moved)`);

  return { sourceId, targetId, sourceTitle: source.title, movedThreadIds };
}

/**
 * Reverse a merge: restore the source work item and re-link its threads/events.
 */
unmergeWorkItem(sourceId: string): void {
  const source = this.getWorkItemById(sourceId);
  if (!source) throw new Error(`Source work item not found: ${sourceId}`);
  if (!source.mergedInto) throw new Error(`Work item ${sourceId} is not merged`);

  const targetId = source.mergedInto;

  // Re-link threads that originally belonged to this source.
  // We identify them by threads whose ID is the source's synthetic thread ID
  // (for thread:xxx items) or were moved during merge.
  // Since synthetic work items use thread:$threadId, we can extract the thread ID.
  const syntheticThreadId = sourceId.startsWith("thread:") ? sourceId.slice(7) : null;
  if (syntheticThreadId) {
    this.db.db
      .prepare("UPDATE threads SET work_item_id = ? WHERE id = ? AND work_item_id = ?")
      .run(sourceId, syntheticThreadId, targetId);
    this.db.db
      .prepare("UPDATE events SET work_item_id = ? WHERE thread_id = ? AND work_item_id = ?")
      .run(sourceId, syntheticThreadId, targetId);
  }

  // Clear merged_into
  this.db.db
    .prepare("UPDATE work_items SET merged_into = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), sourceId);

  log.info("Unmerged work item", sourceId, "from", targetId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/graph.test.ts -t "mergeWorkItems|unmergeWorkItem"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/index.ts tests/core/graph.test.ts
git commit -m "feat: add mergeWorkItems and unmergeWorkItem graph operations"
```

---

### Task 7: Filter Merged Items from Stream Queries

**Files:**
- Modify: `core/graph/index.ts` (add `AND (wi.merged_into IS NULL)` to stream queries)
- Test: `tests/core/graph.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("merged items excluded from queries", () => {
  it("getActionableItems excludes merged work items", () => {
    graph.upsertWorkItem({ id: "WI-merged", source: "test", title: "Merged", currentAtcStatus: "needs_decision" });
    graph.upsertWorkItem({ id: "WI-target", source: "test", title: "Target", currentAtcStatus: "needs_decision" });
    graph.upsertAgent({ id: "U1", name: "Agent", platform: "slack", platformUserId: "U1", avatarUrl: null, isBot: true });

    // Add events to make both actionable
    for (const wiId of ["WI-merged", "WI-target"]) {
      graph.upsertThread({
        id: `t-${wiId}`, channelId: "C1", channelName: "#test",
        platform: "slack", workItemId: wiId,
        lastActivity: new Date().toISOString(), messageCount: 1,
      });
      graph.insertEvent({
        threadId: `t-${wiId}`, messageId: `msg-${wiId}`, workItemId: wiId,
        agentId: "U1", status: "needs_decision", confidence: 0.9,
        reason: "test", rawText: "Help needed",
        timestamp: new Date().toISOString(),
        targetedAtOperator: true,
      });
    }

    // Merge one into the other
    graph.mergeWorkItems("WI-merged", "WI-target");

    const items = graph.getActionableItems();
    const ids = items.map(i => i.workItem.id);
    expect(ids).not.toContain("WI-merged");
    expect(ids).toContain("WI-target");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/graph.test.ts -t "merged items excluded"`
Expected: FAIL — merged item still appears

- [ ] **Step 3: Add `merged_into IS NULL` filter to stream queries**

In `core/graph/index.ts`, add `AND (wi.merged_into IS NULL)` to the WHERE clause of:

1. `getActionableItems()` — the inbox query
2. `getAllActiveItems()` — the "all active" query
3. `getFleetItems()` — the fleet overview query
4. `getSnoozedItems()` — the snoozed items query (if it exists)

Search for each method and add the filter alongside existing WHERE conditions on `wi.`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/graph.test.ts -t "merged items excluded"`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add core/graph/index.ts tests/core/graph.test.ts
git commit -m "feat: exclude merged work items from stream queries"
```

---

### Task 8: Merge & Unmerge API Endpoints

**Files:**
- Modify: `core/server.ts` (add `/api/work-item/:id/merge` and `/api/work-item/:id/unmerge`)
- Test: `tests/core/server.test.ts` (or integration test)

- [ ] **Step 1: Write the failing test**

If `tests/core/server.test.ts` exists, add endpoint tests there. Otherwise, test via the pipeline/graph test with a focused integration:

```typescript
describe("merge API endpoints", () => {
  it("POST /api/work-item/:targetId/merge merges source into target", async () => {
    const res = await app.request("/api/work-item/WI-target/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "WI-source" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.record.sourceId).toBe("WI-source");
  });

  it("POST /api/work-item/:sourceId/unmerge reverses a merge", async () => {
    // First merge
    await app.request("/api/work-item/WI-target/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "WI-source" }),
    });

    // Then unmerge
    const res = await app.request("/api/work-item/WI-source/unmerge", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("returns 404 for non-existent work items", async () => {
    const res = await app.request("/api/work-item/WI-nonexistent/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "WI-also-nonexistent" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — endpoints don't exist (404)

- [ ] **Step 3: Implement the endpoints**

In `core/server.ts`, add after the existing link-thread/unlink-thread endpoints:

```typescript
// POST /api/work-item/:targetId/merge — merge sourceId into targetId
app.post("/api/work-item/:id/merge", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req.json<{ sourceId: string }>();
  if (!body.sourceId) {
    return c.json({ error: "Missing sourceId" }, 400);
  }
  if (!state.graph.getWorkItemById(targetId)) {
    return c.json({ error: "Target work item not found" }, 404);
  }
  if (!state.graph.getWorkItemById(body.sourceId)) {
    return c.json({ error: "Source work item not found" }, 404);
  }
  try {
    const record = state.graph.mergeWorkItems(body.sourceId, targetId);
    return c.json({ ok: true, record });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// POST /api/work-item/:sourceId/unmerge — reverse a merge
app.post("/api/work-item/:id/unmerge", async (c) => {
  const sourceId = c.req.param("id");
  const source = state.graph.getWorkItemById(sourceId);
  if (!source) {
    return c.json({ error: "Work item not found" }, 404);
  }
  if (!source.mergedInto) {
    return c.json({ error: "Work item is not merged" }, 400);
  }
  try {
    state.graph.unmergeWorkItem(sourceId);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/server.test.ts -t "merge API"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/core/server.test.ts
git commit -m "feat: add merge and unmerge API endpoints"
```

---

### Task 9: Frontend — Merge API Client Functions

**Files:**
- Modify: `src/lib/api.ts` (add `mergeWorkItems`, `unmergeWorkItem`, `searchWorkItems`)

- [ ] **Step 1: Add API functions**

In `src/lib/api.ts`, add:

```typescript
export interface MergeRecord {
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  movedThreadIds: string[];
}

export function mergeWorkItems(
  targetId: string,
  sourceId: string,
): Promise<{ ok: boolean; record: MergeRecord }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(targetId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

export function unmergeWorkItem(sourceId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(sourceId)}/unmerge`, {
    method: "POST",
  });
}

export function searchWorkItems(
  query: string,
): Promise<{ items: Array<{ id: string; title: string; currentAtcStatus: string | null }> }> {
  return apiFetch(`/api/work-items/search?q=${encodeURIComponent(query)}`);
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add merge, unmerge, and search API client functions"
```

---

### Task 10: Frontend — UndoToast Component

**Files:**
- Create: `src/components/stream/UndoToast.tsx`

- [ ] **Step 1: Create the UndoToast component**

```typescript
import { useEffect, useState } from "react";

interface UndoToastProps {
  message: string;
  duration?: number; // ms, default 5000
  onUndo: () => void;
  onExpire: () => void;
}

export default function UndoToast({ message, duration = 5000, onUndo, onExpire }: UndoToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onExpire, 300); // wait for exit animation
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onExpire]);

  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
    >
      <div className="bg-gray-800 border border-gray-600 rounded-lg px-4 py-2.5 flex items-center gap-4 shadow-lg">
        <span className="text-sm text-gray-200">✓ {message}</span>
        <button
          onClick={() => {
            onUndo();
            setVisible(false);
          }}
          className="text-purple-400 hover:text-purple-300 text-sm font-semibold flex items-center gap-1"
        >
          Undo <kbd className="text-[10px] bg-gray-700 px-1.5 py-0.5 rounded ml-1">⌘Z</kbd>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/stream/UndoToast.tsx
git commit -m "feat: add UndoToast component for merge undo"
```

---

### Task 11: Frontend — MergeDropdown Component

**Files:**
- Create: `src/components/stream/MergeDropdown.tsx`

- [ ] **Step 1: Create the MergeDropdown component**

```typescript
import { useState, useEffect, useRef } from "react";
import { searchWorkItems } from "../../lib/api";
import type { ActionableItem } from "../../lib/api";

interface MergeTarget {
  id: string;
  title: string;
  channelName?: string;
  timeAgo?: string;
}

interface MergeDropdownProps {
  recentlyViewed: MergeTarget[];
  currentItemId: string;
  onSelect: (targetId: string) => void;
  onClose: () => void;
}

export default function MergeDropdown({ recentlyViewed, currentItemId, onSelect, onClose }: MergeDropdownProps) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MergeTarget[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchWorkItems(query);
        setSearchResults(
          res.items
            .filter((item) => item.id !== currentItemId)
            .map((item) => ({ id: item.id, title: item.title }))
        );
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, currentItemId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredRecent = recentlyViewed.filter((item) => item.id !== currentItemId);
  const showRecent = !query.trim() && filteredRecent.length > 0;
  const items = showRecent ? filteredRecent : searchResults;

  return (
    <div className="absolute right-0 top-full mt-1 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
      {showRecent && (
        <div className="px-3 pt-2 pb-1 text-[11px] text-gray-500 uppercase tracking-wider">
          Recently viewed
        </div>
      )}

      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors flex items-center gap-2"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-200 truncate">{item.title || item.id}</div>
            {item.channelName && (
              <div className="text-[11px] text-gray-500">{item.channelName}{item.timeAgo ? ` · ${item.timeAgo}` : ""}</div>
            )}
          </div>
        </button>
      ))}

      {query.trim() && items.length === 0 && !searching && (
        <div className="px-3 py-3 text-sm text-gray-500 text-center">No matches</div>
      )}
      {searching && (
        <div className="px-3 py-3 text-sm text-gray-500 text-center">Searching…</div>
      )}

      <div className="border-t border-gray-700 p-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search work items..."
          className="w-full bg-gray-950 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/stream/MergeDropdown.tsx
git commit -m "feat: add MergeDropdown component with recent items and search"
```

---

### Task 12: Frontend — MergeSuggestion Banner

**Files:**
- Create: `src/components/stream/MergeSuggestion.tsx`

- [ ] **Step 1: Create the MergeSuggestion component**

```typescript
import { useState, useEffect } from "react";

interface MergeSuggestionProps {
  currentItemId: string;
  currentChannelName: string;
  recentlyViewed: Array<{
    id: string;
    title: string;
    channelName?: string;
  }>;
  onMerge: (targetId: string) => void;
}

// Track dismissed pairs so they don't reappear
const dismissedPairs = new Set<string>();

function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export default function MergeSuggestion({
  currentItemId,
  currentChannelName,
  recentlyViewed,
  onMerge,
}: MergeSuggestionProps) {
  const [dismissed, setDismissed] = useState(false);

  // Find a recently viewed item from the same channel
  const suggestion = recentlyViewed.find(
    (item) =>
      item.id !== currentItemId &&
      item.channelName === currentChannelName &&
      !dismissedPairs.has(pairKey(currentItemId, item.id))
  );

  useEffect(() => {
    setDismissed(false);
  }, [currentItemId]);

  if (!suggestion || dismissed) return null;

  return (
    <div className="bg-gradient-to-r from-purple-900/20 to-purple-800/10 border border-purple-500/20 rounded-lg px-4 py-3 mb-4 flex items-center gap-3 animate-list-enter">
      <span className="text-lg">🔗</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-purple-300">Same conversation?</div>
        <div className="text-[11px] text-gray-400 mt-0.5 truncate">
          You were just viewing "<span className="text-gray-300">{suggestion.title || suggestion.id}</span>" in the same channel
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => onMerge(suggestion.id)}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition-colors"
        >
          Merge
        </button>
        <button
          onClick={() => {
            dismissedPairs.add(pairKey(currentItemId, suggestion.id));
            setDismissed(true);
          }}
          className="px-1.5 py-1.5 text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/stream/MergeSuggestion.tsx
git commit -m "feat: add MergeSuggestion contextual banner component"
```

---

### Task 13: Frontend — "Merge Into..." Action Button

**Files:**
- Modify: `src/components/stream/SuggestedActions.tsx` (add "Merge into..." button)

- [ ] **Step 1: Read the current SuggestedActions component**

Read `src/components/stream/SuggestedActions.tsx` to understand the exact structure and props.

- [ ] **Step 2: Add the merge button and dropdown**

Add a new prop for merge handling and recently viewed items. Add a "Merge into..." button that toggles the MergeDropdown:

```typescript
// Add to SuggestedActions props:
onMerge?: (targetId: string) => void;
recentlyViewed?: Array<{ id: string; title: string; channelName?: string; timeAgo?: string }>;
workItemId?: string;
```

Add the button in the action bar after the existing buttons:

```typescript
{onMerge && (
  <div className="relative">
    <button
      onClick={() => setShowMerge(!showMerge)}
      className="px-3 py-1.5 rounded text-xs font-medium bg-purple-800/50 text-purple-300 border border-purple-700/50 hover:bg-purple-700/50 transition-colors"
    >
      ⤵ Merge into…
    </button>
    {showMerge && (
      <MergeDropdown
        recentlyViewed={recentlyViewed ?? []}
        currentItemId={workItemId ?? ""}
        onSelect={(targetId) => {
          onMerge(targetId);
          setShowMerge(false);
        }}
        onClose={() => setShowMerge(false)}
      />
    )}
  </div>
)}
```

Add `const [showMerge, setShowMerge] = useState(false);` to the component state.

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/stream/SuggestedActions.tsx
git commit -m "feat: add Merge Into action button with dropdown to SuggestedActions"
```

---

### Task 14: Frontend — Wire Merge into StreamView & StreamDetail

**Files:**
- Modify: `src/components/StreamView.tsx` (recently-viewed tracking, merge handler, undo toast, ⌘Z)
- Modify: `src/components/stream/StreamDetail.tsx` (mount MergeSuggestion, pass merge props)
- Modify: `src/index.css` (merge animation keyframes)

- [ ] **Step 1: Add merge animation keyframes to CSS**

In `src/index.css`, add:

```css
@keyframes merge-absorb {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.8); opacity: 0.5; }
  100% { transform: scale(0.6) translateY(-20px); opacity: 0; }
}

@keyframes merge-glow {
  0% { box-shadow: 0 0 0 0 rgba(124, 92, 191, 0); }
  50% { box-shadow: 0 0 16px 4px rgba(124, 92, 191, 0.4); }
  100% { box-shadow: 0 0 0 0 rgba(124, 92, 191, 0); }
}

.animate-merge-absorb {
  animation: merge-absorb 0.3s ease-in forwards;
}

.animate-merge-glow {
  animation: merge-glow 0.6s ease-out;
}
```

- [ ] **Step 2: Add recently-viewed tracking and merge logic to StreamView**

In `src/components/StreamView.tsx`, add state and handlers:

```typescript
import { mergeWorkItems, unmergeWorkItem } from "../lib/api";
import UndoToast from "./stream/UndoToast";

// Inside StreamView component:
const [recentlyViewed, setRecentlyViewed] = useState<
  Array<{ id: string; title: string; channelName?: string; timeAgo?: string }>
>([]);
const [undoState, setUndoState] = useState<{
  message: string;
  sourceId: string;
} | null>(null);
const [mergingId, setMergingId] = useState<string | null>(null);

// Track recently viewed items (max 5)
useEffect(() => {
  if (!selectedWorkItemId) return;
  setRecentlyViewed((prev) => {
    const item = items.find((i) => i.workItem.id === selectedWorkItemId);
    if (!item) return prev;
    const entry = {
      id: item.workItem.id,
      title: item.workItem.title,
      channelName: item.thread?.channelName,
    };
    const filtered = prev.filter((v) => v.id !== selectedWorkItemId);
    return [entry, ...filtered].slice(0, 5);
  });
}, [selectedWorkItemId]);

// Merge handler
const handleMerge = useCallback(async (sourceId: string, targetId: string) => {
  try {
    setMergingId(sourceId);
    // Start merge animation (300ms)
    await new Promise((r) => setTimeout(r, 300));

    const res = await mergeWorkItems(targetId, sourceId);
    setUndoState({
      message: `Merged into "${items.find((i) => i.workItem.id === targetId)?.workItem.title ?? targetId}"`,
      sourceId: res.record.sourceId,
    });

    // Select the target after merge
    setSelectedWorkItemId(targetId);
    setMergingId(null);
  } catch (err) {
    console.error("Merge failed", err);
    setMergingId(null);
  }
}, [items]);

// Undo handler
const handleUndo = useCallback(async () => {
  if (!undoState) return;
  try {
    await unmergeWorkItem(undoState.sourceId);
    setUndoState(null);
  } catch (err) {
    console.error("Unmerge failed", err);
  }
}, [undoState]);

// ⌘Z keyboard shortcut for undo
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && undoState) {
      e.preventDefault();
      handleUndo();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [undoState, handleUndo]);
```

Pass merge props to StreamDetail:

```typescript
<StreamDetail
  workItemId={selectedWorkItemId}
  // ... existing props
  onMerge={(targetId) => handleMerge(selectedWorkItemId, targetId)}
  recentlyViewed={recentlyViewed}
/>
```

Add the UndoToast at the bottom of the component:

```typescript
{undoState && (
  <UndoToast
    message={undoState.message}
    onUndo={handleUndo}
    onExpire={() => setUndoState(null)}
  />
)}
```

Add merge animation class to StreamListItem:

```typescript
<StreamListItem
  // ... existing props
  className={mergingId === item.workItem.id ? "animate-merge-absorb" : ""}
/>
```

- [ ] **Step 3: Update StreamDetail to accept and use merge props**

In `src/components/stream/StreamDetail.tsx`, add props:

```typescript
interface StreamDetailProps {
  // ... existing props
  onMerge?: (targetId: string) => void;
  recentlyViewed?: Array<{ id: string; title: string; channelName?: string }>;
}
```

Mount MergeSuggestion at the top of the detail panel (before the timeline):

```typescript
import MergeSuggestion from "./MergeSuggestion";

// Inside the render, before StatusSnapshot:
{onMerge && recentlyViewed && data && (
  <MergeSuggestion
    currentItemId={workItemId}
    currentChannelName={data.channels?.[0]?.name ?? ""}
    recentlyViewed={recentlyViewed}
    onMerge={onMerge}
  />
)}
```

Pass merge props to SuggestedActions:

```typescript
<SuggestedActions
  // ... existing props
  onMerge={onMerge}
  recentlyViewed={recentlyViewed}
  workItemId={workItemId}
/>
```

- [ ] **Step 4: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamView.tsx src/components/stream/StreamDetail.tsx src/index.css
git commit -m "feat: wire merge flow into StreamView and StreamDetail with undo and animations"
```

---

### Task 15: Frontend — Drag to Merge in List View

**Files:**
- Modify: `src/components/stream/StreamListItem.tsx` (add drag source behavior)
- Modify: `src/components/StreamView.tsx` (add drop target handling)

- [ ] **Step 1: Add drag source to StreamListItem**

In `src/components/stream/StreamListItem.tsx`, add HTML5 drag support:

```typescript
// Add to props:
onDragStart?: (id: string) => void;
onDragEnd?: () => void;
onDrop?: (targetId: string) => void;
dragOverId?: string | null;

// In the component:
const isDragOver = dragOverId === item.workItem.id;

// On the root div:
<div
  draggable
  onDragStart={(e) => {
    e.dataTransfer.setData("text/plain", item.workItem.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart?.(item.workItem.id);
  }}
  onDragEnd={() => onDragEnd?.()}
  onDragOver={(e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }}
  onDrop={(e) => {
    e.preventDefault();
    onDrop?.(item.workItem.id);
  }}
  className={`... ${isDragOver ? "ring-1 ring-purple-500 animate-merge-glow" : ""}`}
>
  {isDragOver && (
    <div className="absolute inset-0 flex items-center justify-center bg-purple-900/20 rounded text-purple-400 text-xs font-medium z-10">
      ⤵ Drop to merge
    </div>
  )}
  {/* existing content */}
</div>
```

- [ ] **Step 2: Add drag state tracking to StreamView**

In `src/components/StreamView.tsx`, add:

```typescript
const [draggingId, setDraggingId] = useState<string | null>(null);
const [dragOverId, setDragOverId] = useState<string | null>(null);

// Track which item is being hovered during drag
const handleDragOverItem = useCallback((targetId: string) => {
  if (targetId !== draggingId) {
    setDragOverId(targetId);
  }
}, [draggingId]);

// Handle drop
const handleDrop = useCallback((targetId: string) => {
  if (draggingId && draggingId !== targetId) {
    handleMerge(draggingId, targetId);
  }
  setDraggingId(null);
  setDragOverId(null);
}, [draggingId, handleMerge]);
```

Pass to each StreamListItem:

```typescript
<StreamListItem
  // ... existing props
  onDragStart={setDraggingId}
  onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
  onDragOver={() => handleDragOverItem(item.workItem.id)}
  onDrop={() => handleDrop(item.workItem.id)}
  dragOverId={dragOverId}
/>
```

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/stream/StreamListItem.tsx src/components/StreamView.tsx
git commit -m "feat: add drag-to-merge interaction in stream list view"
```

---

### Task 16: Frontend — Keyboard Shortcuts (M, ⇧M)

**Files:**
- Modify: `src/components/StreamView.tsx` (add M and ⇧M keyboard handlers)

- [ ] **Step 1: Add keyboard shortcuts**

In `src/components/StreamView.tsx`, extend the existing keyboard handler:

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Don't capture when typing in inputs
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // ⌘Z — undo merge (already handled above)

    // M — open merge dropdown (dispatched to detail panel)
    if (e.key === "m" && !e.metaKey && !e.ctrlKey && !e.shiftKey && selectedWorkItemId) {
      e.preventDefault();
      // Dispatch custom event that SuggestedActions listens for
      window.dispatchEvent(new CustomEvent("workstream:open-merge-dropdown"));
    }

    // ⇧M — instant merge with previously viewed item
    if (e.key === "M" && e.shiftKey && !e.metaKey && !e.ctrlKey && selectedWorkItemId) {
      e.preventDefault();
      const target = recentlyViewed.find((v) => v.id !== selectedWorkItemId);
      if (target) {
        handleMerge(selectedWorkItemId, target.id);
      }
    }
  };

  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [selectedWorkItemId, recentlyViewed, handleMerge]);
```

In `src/components/stream/SuggestedActions.tsx`, listen for the custom event:

```typescript
useEffect(() => {
  const handler = () => setShowMerge(true);
  window.addEventListener("workstream:open-merge-dropdown", handler);
  return () => window.removeEventListener("workstream:open-merge-dropdown", handler);
}, []);
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/StreamView.tsx src/components/stream/SuggestedActions.tsx
git commit -m "feat: add M and ⇧M keyboard shortcuts for merge"
```

---

### Task 17: Continuation Strategy Interface (Extensibility)

**Files:**
- Create: `core/continuation/interface.ts`

- [ ] **Step 1: Create the interface file**

```typescript
// core/continuation/interface.ts — Extensibility types for continuation detection strategies

import type { Message } from "../types.js";

/**
 * A recent message from the same channel, used as context for continuation detection.
 */
export interface RecentChannelMessage {
  workItemId: string;
  workItemTitle: string;
  senderName: string;
  text: string;
  timestamp: string;
}

/**
 * Result of a continuation check — indicates the message should be linked
 * to an existing work item rather than creating a new one.
 */
export interface ContinuationResult {
  workItemId: string;
  confidence: number;
  refinedTitle?: string;
}

/**
 * Pluggable strategy for detecting conversation continuations.
 *
 * Implementations:
 * - ClassifierInline (shipped): enriches the classifier prompt with channel context.
 *   Returns null — the continuation decision is made by the classifier itself.
 * - PreClassifier (future): separate lightweight LLM call before classification.
 * - HeuristicPrefilter (future): deterministic checks before classifier enrichment.
 */
export interface ContinuationStrategy {
  name: string;
  findContinuation(params: {
    message: Message;
    channelId: string;
    recentMessages: RecentChannelMessage[];
  }): Promise<ContinuationResult | null>;
}
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add core/continuation/interface.ts
git commit -m "feat: add ContinuationStrategy interface for future extensibility"
```

---

### Task 18: Search API Endpoint (for MergeDropdown)

**Files:**
- Modify: `core/server.ts` (add `/api/work-items/search` endpoint)

- [ ] **Step 1: Check if search endpoint already exists**

Search `core/server.ts` for an existing search endpoint. The graph already has `searchWorkItems(query)`.

- [ ] **Step 2: Add endpoint if missing**

In `core/server.ts`:

```typescript
// GET /api/work-items/search — search work items by query
app.get("/api/work-items/search", (c) => {
  const query = c.req.query("q") ?? "";
  if (!query.trim()) {
    return c.json({ items: [] });
  }
  const items = state.graph.searchWorkItems(query)
    .filter((wi) => !wi.mergedInto)
    .map((wi) => ({
      id: wi.id,
      title: wi.title,
      currentAtcStatus: wi.currentAtcStatus,
    }));
  return c.json({ items });
});
```

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add core/server.ts
git commit -m "feat: add work items search API endpoint for merge dropdown"
```

---

### Task 19: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Manual smoke test**

1. Start the dev server: `npm run dev`
2. Open the app, navigate to the stream view
3. Verify merged items don't appear in the list
4. Verify the "Merge into..." button appears in the action bar
5. Verify drag-and-drop works between list items
6. Verify `M` opens the merge dropdown, `⇧M` quick-merges
7. Verify undo toast appears after merge, `⌘Z` works
8. Check the pipeline logs to confirm channel context is being gathered

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: conversation continuation detection and work item merge

Auto-groups non-threaded messages from the same channel conversation by
enriching the classifier prompt with recent channel context. Adds manual
merge with four interaction patterns: contextual suggestion banner,
Merge Into dropdown, drag-to-merge in list, and keyboard shortcuts."
```
