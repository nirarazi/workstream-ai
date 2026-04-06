# LLM Token Optimization & Budget Control — Design Spec

## Goal

Reduce unnecessary LLM calls, track token consumption and cost in real time, and enforce a daily spending limit. Operators see what they're spending, set a hard budget, and the system respects it.

## Architecture

A new `UsageTracker` module owns the LLM provider instance and is the sole gateway for all LLM calls. The classifier, summarizer, and sidekick call the tracker — never the provider directly. The tracker records every call to SQLite, calculates cost, and enforces the daily budget. Three call-reduction optimizations are layered into the pipeline to reduce unnecessary classifications.

---

## 1. Usage Data Model

### UsageRecord

```typescript
// core/usage/types.ts

export interface UsageRecord {
  id: string;                                    // auto-generated UUID
  caller: string;                                // "classifier" | "summarizer" | "sidekick"
  timestamp: string;                             // ISO 8601 UTC
  inputTokens: number;                           // from API response or estimated
  outputTokens: number;                          // from API response or estimated
  tokenSource: "actual" | "estimated";           // how token counts were obtained
  cost: number | null;                           // USD, null if no pricing available
  costSource: "api" | "configured" | null;       // how cost was calculated
  model: string;                                 // model name used for this call
}

export interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  byCaller: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
  }>;
}

export interface BudgetStatus {
  dailyBudget: number | null;       // null = unlimited
  spent: number | null;             // null = no cost data
  remaining: number | null;         // null = no budget or no cost data
  exhausted: boolean;
}
```

### SQLite table: `llm_usage`

```sql
CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  token_source TEXT NOT NULL,
  cost REAL,
  cost_source TEXT,
  model TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_usage_caller ON llm_usage(caller);
```

Daily aggregation is a query — `SUM(input_tokens)`, `SUM(output_tokens)`, `SUM(cost)` with `WHERE timestamp >= ?` (today's midnight UTC). No separate aggregation table needed. At ~5,000 records/day max, this is trivial for SQLite.

### Data retention

Records older than 365 days are pruned on server startup: `DELETE FROM llm_usage WHERE timestamp < ?`. One year of history is retained.

---

## 2. UsageTracker Module

### Interface

The existing codebase has three independent LLM call paths: the classifier uses `OpenAICompatibleProvider.classify()`, while the summarizer and sidekick make raw `fetch()` calls directly. The tracker wraps the provider at the provider interface level and exposes a `fetch`-style method for the summarizer and sidekick.

```typescript
// core/usage/tracker.ts

export class UsageTracker {
  constructor(
    provider: OpenAICompatibleProvider,
    db: Database,
    config: UsageConfig,
  );

  // For the classifier — wraps provider.classify() with tracking
  classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
    caller: string,
  ): Promise<ClassificationResult>;

  // For the summarizer and sidekick — wraps fetch() with tracking
  // Caller passes the request body; tracker intercepts the response to extract usage
  completionCall(
    url: string,
    options: RequestInit,
    caller: string,
  ): Promise<Response>;

  // Query usage
  getTodayUsage(): DailyUsage;
  getBudgetStatus(): BudgetStatus;
  isBudgetExhausted(): boolean;

  // Expose backoff state (delegated to underlying provider)
  getBackoffState(): BackoffState;
}
```

The classifier calls `tracker.classify()`. The summarizer and sidekick call `tracker.completionCall()` instead of `fetch()` — same API surface, but the tracker intercepts the response to record usage before returning it. This means the summarizer and sidekick need minimal changes: replace `fetch(url, options)` with `tracker.completionCall(url, options, "summarizer")`.

### Call flow

On every LLM call (both `classify` and `completionCall`):

1. **Check budget** — if `isBudgetExhausted()`, reject immediately:
   - For classifier: return fallback `{ status: "noise", confidence: 0.1, reason: "LLM budget exhausted" }`
   - For summarizer/sidekick: throw an error with message "Daily LLM budget exhausted. Resets at midnight UTC."
2. **Forward the call** — `classify()` delegates to the provider; `completionCall()` calls `fetch()`
3. **Extract usage from API response** — parse the JSON response for `usage.input_tokens` / `usage.output_tokens` (Anthropic) or `usage.prompt_tokens` / `usage.completion_tokens` (OpenAI)
   - If present: `tokenSource: "actual"`
   - If absent: estimate as `Math.ceil(inputText.length / 4)` for input, `Math.ceil(outputText.length / 4)` for output. `tokenSource: "estimated"`
4. **Calculate cost:**
   - If API response includes cost data → use it, `costSource: "api"`
   - Else if operator configured pricing → `(inputTokens * inputCostPerMillion / 1_000_000) + (outputTokens * outputCostPerMillion / 1_000_000)`, `costSource: "configured"`
   - Else → `cost: null`, `costSource: null`
5. **Persist** — insert `UsageRecord` into `llm_usage` table
6. **Return** — pass through the result unchanged. For `completionCall()`, the response is cloned so the caller can still read the body.

### Budget enforcement

`isBudgetExhausted()` runs a SQL query: `SELECT SUM(cost) FROM llm_usage WHERE timestamp >= ?` against today's midnight UTC. If `SUM(cost) >= dailyBudget`, the budget is exhausted.

When budget is exhausted:
- The pipeline keeps polling Slack — messages are still read and threads are stored
- Classification stops — threads accumulate unclassified
- Once the budget resets (next UTC day), the classifier processes the backlog
- Summarizer and sidekick return error messages to the UI

### Construction and wiring

The `UsageTracker` is created during server bootstrap in `main()`. It receives the provider instance. The classifier receives the tracker instead of a direct provider reference and calls `tracker.classify()`. The summarizer and sidekick receive the tracker and call `tracker.completionCall()` instead of `fetch()`. No module other than `UsageTracker` holds a reference to the provider.

```
Classifier ──┐
Summarizer ──┼──► UsageTracker (owns provider) ──► LLM API
Sidekick ────┘
```

---

## 3. Token Optimization — Reducing Unnecessary Calls

Three optimizations in the pipeline, ordered by impact:

### 3a. Skip completed work items

If a work item's status is `completed` (operator approved/closed it), new messages in its threads don't need classification. The pipeline checks `workItem.currentAtcStatus` before calling the classifier.

**Where:** `Pipeline.processMessage()`, before the classifier call.
**Savings:** Eliminates classification for all post-resolution chatter. Significant for active fleets where agents post confirmations after the operator has already moved on.

### 3b. Message content hash deduplication

Agents sometimes post identical status updates ("Still working on AI-382..."). Before classifying, hash the message text (SHA-256) and check if the same hash exists for the same work item within the last hour.

**Where:** In-memory LRU cache in the pipeline, keyed by `{workItemId}:{contentHash}`. TTL: 1 hour. Max entries: 1,000.
**Savings:** Eliminates redundant classifications for repetitive agent updates.

### 3c. Skip bot/system messages

Some messages are clearly not agent work — Slack bot notifications, join/leave messages, app integrations. A lightweight pre-filter checks message metadata before the message reaches the classifier.

**Where:** `Pipeline.processMessage()`, as the first check. Uses message subtype and bot flags already available from the Slack adapter's thread data.
**Savings:** Depends on workspace noise level. Can be significant in busy workspaces with many integrations.

### Optimization order in the pipeline

```
Message received
  → Skip if bot/system message (3c, free)
  → Skip if content hash seen in last hour (3b, free)
  → Skip if work item already completed (3a, free)
  → Classify via UsageTracker (LLM call)
```

All three checks are near-zero cost (no LLM, no network). They run before the rate limiter `acquire()` call, so skipped messages don't consume rate limit slots either.

---

## 4. Configuration

### Config schema

```yaml
# config/default.yaml — new section
llmBudget:
  dailyBudget: null              # USD per day, null = unlimited
  inputCostPerMillion: null      # USD per 1M input tokens, null = no configured pricing
  outputCostPerMillion: null     # USD per 1M output tokens, null = no configured pricing
```

### UsageConfig type

```typescript
export interface UsageConfig {
  dailyBudget: number | null;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
}
```

### Setup page changes

Three new fields in the LLM section of the setup form, below the existing API key / base URL / model fields:

| Field | Label | Type | Required | Placeholder | Help text |
|-------|-------|------|----------|-------------|-----------|
| `dailyBudget` | Daily Budget ($) | number | no | "20.00" | "Leave empty for unlimited" |
| `inputCostPerMillion` | Input cost per 1M tokens ($) | number | no | "3.00" | "Leave empty if your API returns cost data" |
| `outputCostPerMillion` | Output cost per 1M tokens ($) | number | no | "15.00" | "" |

These are NOT adapter fields — they belong to the LLM section which uses hardcoded presets. They're added as regular form fields alongside the existing LLM inputs.

### Setup API changes

**`POST /api/setup`** — accept new fields in the `llm` section:

```typescript
llm?: {
  apiKey: string;
  baseUrl: string;
  model: string;
  dailyBudget?: number | null;
  inputCostPerMillion?: number | null;
  outputCostPerMillion?: number | null;
}
```

The handler writes budget config to `config/local.yaml` under `llmBudget` and reconfigures the `UsageTracker`.

**`GET /api/setup/prefill`** — include budget config in the `llm` section of the response.

---

## 5. Status Display

### Status bar

The LLM indicator in the status bar gains a cost suffix:

| State | Display |
|-------|---------|
| Cost tracking active, budget set | `LLM ● $1.23 / $20.00` |
| Cost tracking active, no budget | `LLM ● $1.23` |
| No cost data (no pricing configured, API doesn't return cost) | `LLM ●` (unchanged) |
| Budget exhausted | `LLM ● $20.00 / $20.00 (paused)` — indicator turns amber (degraded) |

### API response

`GET /api/status` adds an `llmUsage` field to the existing response:

```typescript
{
  // ... existing fields ...
  llmUsage: {
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    costSource: "api" | "configured" | null;
    dailyBudget: number | null;
    exhausted: boolean;
  }
}
```

No new endpoints. The frontend's existing status polling picks this up automatically.

---

## 6. Budget Reset & Persistence

**Daily reset:** No timer or cron. The tracker queries `WHERE timestamp >= today_midnight_utc`. When a new UTC day begins, old records fall outside the window. The budget "resets" by query scope.

**Server restart:** No state lost. Usage records are in SQLite. The tracker reads from the database on every budget check, so restarting mid-day continues where it left off.

**Data retention:** Records older than 365 days are pruned on server startup via `DELETE FROM llm_usage WHERE timestamp < ?`.

---

## 7. What Stays the Same

- **Rate limiting** — unchanged. Budget is about cost; rate limiting is about API throttling. They coexist independently.
- **Classifier prompt and few-shot examples** — untouched. Optimizations reduce which messages reach the classifier, not what it does.
- **Summarizer caching** — already in place, keeps working.
- **Sidekick tool loop** — unchanged. Each LLM call in the loop goes through the tracker as a separate usage record.
- **Backoff logic** — stays in the provider. The tracker wraps the provider including its retry behavior. A retried call that eventually succeeds records the final usage only.
- **Config file format** — `config/default.yaml` structure unchanged, just adds the new `llmBudget` section.

---

## 8. Testing

- **UsageTracker unit tests** — mock provider, verify records are persisted with correct token counts, cost calculations, and caller tags
- **Budget enforcement tests** — verify classifier returns fallback when budget exhausted, summarizer/sidekick throw errors
- **Cost calculation priority** — verify: API cost > configured rate > null
- **Token source** — verify: actual from API response > estimated fallback
- **Pipeline optimization tests** — verify skip logic for completed work items, duplicate messages, bot messages
- **Daily aggregation** — verify correct summing within UTC day boundaries
- **Data retention** — verify records older than 365 days are pruned on startup
- **Setup API** — verify budget config is accepted, persisted, and returned in prefill
- **Status API** — verify `llmUsage` field is present and correct
