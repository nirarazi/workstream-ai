# LLM Token Optimization & Budget Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track LLM token consumption and cost in real time, enforce a daily spending limit, and reduce unnecessary classifier calls.

**Architecture:** A `UsageTracker` module owns the LLM provider and is the sole gateway for all LLM calls. It records every call to SQLite, calculates cost (from API response, configured rate, or null), and enforces a daily budget. Three pipeline optimizations skip unnecessary classifications before they reach the LLM.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Hono (server), React (frontend), Vitest (tests)

---

## File Structure

### New files
- `core/usage/types.ts` — UsageRecord, DailyUsage, BudgetStatus, UsageConfig types
- `core/usage/tracker.ts` — UsageTracker class (owns provider, records usage, enforces budget)
- `tests/usage/tracker.test.ts` — UsageTracker unit tests
- `tests/usage/pipeline-optimizations.test.ts` — Pipeline skip-logic tests

### Modified files
- `core/graph/db.ts` — Add `llm_usage` table to schema + retention cleanup
- `core/classifier/index.ts` — Accept UsageTracker instead of direct provider; delegate `classify()` through it
- `core/summarizer/index.ts` — Accept UsageTracker; use `tracker.completionCall()` instead of `fetch()`
- `core/sidekick/index.ts` — Accept UsageTracker; use `tracker.completionCall()` instead of `fetch()`
- `core/pipeline.ts` — Add three skip optimizations before classification
- `core/config.ts` — Add `llmBudget` section to config schema
- `config/default.yaml` — Add `llmBudget` defaults
- `core/server.ts` — Wire UsageTracker into bootstrap; add `llmUsage` to `/api/status`; accept budget config in `POST /api/setup`; return budget in prefill
- `src/lib/api.ts` — Add `llmUsage` to EngineStatus; add budget fields to SetupPayload/SetupPrefill
- `src/components/Setup.tsx` — Add 3 budget fields to LLM section
- `src/App.tsx` — Display cost in LLM service indicator

---

### Task 1: Usage Types

**Files:**
- Create: `core/usage/types.ts`
- Test: `tests/usage/tracker.test.ts` (initial type-shape tests)

- [ ] **Step 1: Write the failing test**

Create `tests/usage/tracker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { UsageRecord, DailyUsage, BudgetStatus, UsageConfig } from "../../core/usage/types.js";

describe("Usage types", () => {
  it("UsageRecord has required shape", () => {
    const record: UsageRecord = {
      id: "test-1",
      caller: "classifier",
      timestamp: "2026-04-06T12:00:00Z",
      inputTokens: 1200,
      outputTokens: 300,
      tokenSource: "actual",
      cost: 0.0045,
      costSource: "configured",
      model: "claude-sonnet-4-6",
    };

    expect(record.caller).toBe("classifier");
    expect(record.tokenSource).toBe("actual");
    expect(record.costSource).toBe("configured");
  });

  it("DailyUsage has per-caller breakdown", () => {
    const usage: DailyUsage = {
      inputTokens: 5000,
      outputTokens: 1000,
      cost: 0.02,
      byCaller: {
        classifier: { inputTokens: 4000, outputTokens: 800, cost: 0.015, callCount: 10 },
        summarizer: { inputTokens: 1000, outputTokens: 200, cost: 0.005, callCount: 1 },
      },
    };

    expect(usage.byCaller.classifier.callCount).toBe(10);
    expect(usage.cost).toBe(0.02);
  });

  it("BudgetStatus reports exhaustion correctly", () => {
    const status: BudgetStatus = {
      dailyBudget: 20.0,
      spent: 20.0,
      remaining: 0,
      exhausted: true,
    };

    expect(status.exhausted).toBe(true);
    expect(status.remaining).toBe(0);
  });

  it("UsageConfig allows null for unlimited/no-pricing", () => {
    const config: UsageConfig = {
      dailyBudget: null,
      inputCostPerMillion: null,
      outputCostPerMillion: null,
    };

    expect(config.dailyBudget).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: FAIL — cannot find module `../../core/usage/types.js`

- [ ] **Step 3: Write the types**

Create `core/usage/types.ts`:

```typescript
// core/usage/types.ts — Types for LLM usage tracking and budget control

export interface UsageRecord {
  id: string;
  caller: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  tokenSource: "actual" | "estimated";
  cost: number | null;
  costSource: "api" | "configured" | null;
  model: string;
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
  dailyBudget: number | null;
  spent: number | null;
  remaining: number | null;
  exhausted: boolean;
}

export interface UsageConfig {
  dailyBudget: number | null;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/usage/types.ts tests/usage/tracker.test.ts
git commit -m "feat: add LLM usage tracking types"
```

---

### Task 2: SQLite Schema — `llm_usage` Table

**Files:**
- Modify: `core/graph/db.ts`
- Test: `tests/usage/tracker.test.ts` (add schema tests)

- [ ] **Step 1: Write the failing test**

Add to `tests/usage/tracker.test.ts`:

```typescript
import { Database } from "../../core/graph/db.js";

describe("llm_usage table", () => {
  it("exists after Database initialization", () => {
    const db = new Database(":memory:");
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_usage'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("supports insert and query by timestamp", () => {
    const db = new Database(":memory:");
    db.db.prepare(`
      INSERT INTO llm_usage (id, caller, timestamp, input_tokens, output_tokens, token_source, cost, cost_source, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("u1", "classifier", "2026-04-06T12:00:00Z", 1200, 300, "actual", 0.005, "configured", "claude-sonnet-4-6");

    const rows = db.db.prepare("SELECT * FROM llm_usage WHERE timestamp >= ?").all("2026-04-06T00:00:00Z") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].caller).toBe("classifier");
    expect(rows[0].input_tokens).toBe(1200);
    db.close();
  });

  it("has indexes on timestamp and caller", () => {
    const db = new Database(":memory:");
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_usage'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_llm_usage_timestamp");
    expect(names).toContain("idx_llm_usage_caller");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: FAIL — `llm_usage` table does not exist

- [ ] **Step 3: Add the table to the schema**

In `core/graph/db.ts`, add the `llm_usage` table and indexes to the end of the `SCHEMA_SQL` string (before the closing backtick), right after the existing `CREATE TABLE IF NOT EXISTS summaries` block:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/graph/db.ts tests/usage/tracker.test.ts
git commit -m "schema: add llm_usage table for token tracking"
```

---

### Task 3: UsageTracker — Core Module

**Files:**
- Create: `core/usage/tracker.ts`
- Modify: `tests/usage/tracker.test.ts`

This is the biggest task. The UsageTracker wraps the provider for `classify()` and wraps `fetch()` for `completionCall()`. It records usage, calculates cost, and enforces the daily budget.

- [ ] **Step 1: Write failing tests for UsageTracker**

Add to `tests/usage/tracker.test.ts`:

```typescript
import { vi } from "vitest";
import { UsageTracker } from "../../core/usage/tracker.js";
import type { UsageConfig } from "../../core/usage/types.js";
import type { ModelProvider, ClassificationResult } from "../../core/classifier/providers/interface.js";

function mockProvider(result: ClassificationResult): ModelProvider {
  return {
    name: "mock",
    classify: vi.fn().mockResolvedValue(result),
  };
}

const DEFAULT_CONFIG: UsageConfig = {
  dailyBudget: null,
  inputCostPerMillion: 3.0,
  outputCostPerMillion: 15.0,
};

describe("UsageTracker", () => {
  it("delegates classify() to the provider and records usage", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "completed",
      confidence: 0.95,
      reason: "done",
      workItemIds: ["AI-1"],
      title: "Deploy fix",
    });

    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);
    const result = await tracker.classify("AI-1: PR merged", "system prompt", [], "classifier");

    expect(result.status).toBe("completed");
    expect(provider.classify).toHaveBeenCalledWith("AI-1: PR merged", "system prompt", []);

    // Check a record was persisted
    const rows = db.db.prepare("SELECT * FROM llm_usage").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].caller).toBe("classifier");
    expect(rows[0].token_source).toBe("estimated");
    expect(typeof rows[0].input_tokens).toBe("number");
    expect((rows[0].input_tokens as number)).toBeGreaterThan(0);
    db.close();
  });

  it("calculates cost from configured rates", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "noise", confidence: 0.8, reason: "greeting", workItemIds: [], title: "",
    });

    const tracker = new UsageTracker(provider, db, {
      dailyBudget: null,
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
    });

    await tracker.classify("Hello world", "sys", [], "classifier");

    const rows = db.db.prepare("SELECT * FROM llm_usage").all() as Array<Record<string, unknown>>;
    expect(rows[0].cost_source).toBe("configured");
    expect(typeof rows[0].cost).toBe("number");
    expect((rows[0].cost as number)).toBeGreaterThan(0);
    db.close();
  });

  it("returns null cost when no pricing configured", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "noise", confidence: 0.8, reason: "greeting", workItemIds: [], title: "",
    });

    const tracker = new UsageTracker(provider, db, {
      dailyBudget: null,
      inputCostPerMillion: null,
      outputCostPerMillion: null,
    });

    await tracker.classify("Hello world", "sys", [], "classifier");

    const rows = db.db.prepare("SELECT * FROM llm_usage").all() as Array<Record<string, unknown>>;
    expect(rows[0].cost).toBeNull();
    expect(rows[0].cost_source).toBeNull();
    db.close();
  });

  it("rejects classify() when daily budget is exhausted", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "completed", confidence: 0.95, reason: "done", workItemIds: [], title: "",
    });

    const tracker = new UsageTracker(provider, db, {
      dailyBudget: 0.001,
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
    });

    // First call succeeds and exhausts the budget
    await tracker.classify("Hello", "sys", [], "classifier");

    // Second call should return budget-exhausted fallback
    const result = await tracker.classify("World", "sys", [], "classifier");
    expect(result.status).toBe("noise");
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain("budget");

    // Provider should NOT have been called for the second classify
    expect(provider.classify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("getTodayUsage() aggregates correctly", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "noise", confidence: 0.8, reason: "x", workItemIds: [], title: "",
    });

    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);

    await tracker.classify("msg1", "sys", [], "classifier");
    await tracker.classify("msg2", "sys", [], "summarizer");

    const usage = tracker.getTodayUsage();
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(Object.keys(usage.byCaller)).toContain("classifier");
    expect(Object.keys(usage.byCaller)).toContain("summarizer");
    expect(usage.byCaller.classifier.callCount).toBe(1);
    expect(usage.byCaller.summarizer.callCount).toBe(1);
    db.close();
  });

  it("getBudgetStatus() returns correct remaining", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "noise", confidence: 0.8, reason: "x", workItemIds: [], title: "",
    });

    const tracker = new UsageTracker(provider, db, {
      dailyBudget: 10.0,
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
    });

    await tracker.classify("Hello world test message", "sys", [], "classifier");

    const status = tracker.getBudgetStatus();
    expect(status.dailyBudget).toBe(10.0);
    expect(status.spent).toBeGreaterThan(0);
    expect(status.remaining).toBeLessThan(10.0);
    expect(status.exhausted).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: FAIL — cannot find module `../../core/usage/tracker.js`

- [ ] **Step 3: Implement UsageTracker**

Create `core/usage/tracker.ts`:

```typescript
// core/usage/tracker.ts — Sole gateway for all LLM calls. Records usage, calculates cost, enforces daily budget.

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { ModelProvider, ClassificationResult } from "../classifier/providers/interface.js";
import type { BackoffState } from "../classifier/providers/openai-compatible.js";
import { OpenAICompatibleProvider } from "../classifier/providers/openai-compatible.js";
import type { Database } from "../graph/db.js";
import type { UsageRecord, DailyUsage, BudgetStatus, UsageConfig } from "./types.js";

const log = createLogger("usage-tracker");

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function todayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export class UsageTracker {
  private readonly provider: ModelProvider;
  private readonly db: Database;
  private config: UsageConfig;

  private readonly insertStmt;
  private readonly sumTodayStmt;
  private readonly sumByCallerStmt;

  constructor(provider: ModelProvider, db: Database, config: UsageConfig) {
    this.provider = provider;
    this.db = db;
    this.config = config;

    this.insertStmt = db.db.prepare(`
      INSERT INTO llm_usage (id, caller, timestamp, input_tokens, output_tokens, token_source, cost, cost_source, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.sumTodayStmt = db.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        SUM(cost) AS cost
      FROM llm_usage
      WHERE timestamp >= ?
    `);

    this.sumByCallerStmt = db.db.prepare(`
      SELECT
        caller,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        SUM(cost) AS cost,
        COUNT(*) AS call_count
      FROM llm_usage
      WHERE timestamp >= ?
      GROUP BY caller
    `);
  }

  /** Update config (e.g. after setup page changes) */
  updateConfig(config: UsageConfig): void {
    this.config = config;
  }

  /** Classify a message — wraps provider.classify() with tracking and budget enforcement */
  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
    caller: string,
  ): Promise<ClassificationResult> {
    if (this.isBudgetExhausted()) {
      log.warn("Daily LLM budget exhausted — returning fallback classification");
      return {
        status: "noise",
        confidence: 0.1,
        reason: "Daily LLM budget exhausted. Resets at midnight UTC.",
        workItemIds: [],
        title: "",
      };
    }

    const result = await this.provider.classify(message, systemPrompt, fewShotExamples);

    // Estimate tokens (provider doesn't expose usage data via the classify interface)
    const fewShotText = fewShotExamples.map((e) => e.content).join("");
    const inputTokens = estimateTokens(systemPrompt + fewShotText + message);
    const outputTokens = estimateTokens(JSON.stringify(result));

    this.recordUsage(caller, inputTokens, outputTokens, "estimated");

    return result;
  }

  /**
   * Make a completion call — wraps fetch() with tracking and budget enforcement.
   * Used by summarizer and sidekick. Returns the parsed JSON response.
   * The caller passes the same args they would pass to fetch().
   */
  async completionCall(
    url: string,
    options: RequestInit,
    caller: string,
  ): Promise<Response> {
    if (this.isBudgetExhausted()) {
      throw new Error("Daily LLM budget exhausted. Resets at midnight UTC.");
    }

    const response = await fetch(url, options);

    // Clone so we can read usage without consuming the body for the caller
    const cloned = response.clone();

    // Try to extract usage from the response
    try {
      const json = await cloned.json();
      const usage = json?.usage;

      let inputTokens: number;
      let outputTokens: number;
      let tokenSource: "actual" | "estimated";

      if (usage?.input_tokens != null || usage?.prompt_tokens != null) {
        inputTokens = usage.input_tokens ?? usage.prompt_tokens;
        outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
        tokenSource = "actual";
      } else {
        // Estimate from request body and response
        const bodyStr = typeof options.body === "string" ? options.body : "";
        const responseText = JSON.stringify(json);
        inputTokens = estimateTokens(bodyStr);
        outputTokens = estimateTokens(responseText);
        tokenSource = "estimated";
      }

      this.recordUsage(caller, inputTokens, outputTokens, tokenSource);
    } catch {
      // If we can't parse the response, estimate from request body
      const bodyStr = typeof options.body === "string" ? options.body : "";
      this.recordUsage(caller, estimateTokens(bodyStr), 50, "estimated");
    }

    return response;
  }

  /** Query today's usage aggregated */
  getTodayUsage(): DailyUsage {
    const midnight = todayMidnightUTC();

    const totals = this.sumTodayStmt.get(midnight) as {
      input_tokens: number;
      output_tokens: number;
      cost: number | null;
    };

    const callerRows = this.sumByCallerStmt.all(midnight) as Array<{
      caller: string;
      input_tokens: number;
      output_tokens: number;
      cost: number | null;
      call_count: number;
    }>;

    const byCaller: DailyUsage["byCaller"] = {};
    for (const row of callerRows) {
      byCaller[row.caller] = {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cost: row.cost,
        callCount: row.call_count,
      };
    }

    return {
      inputTokens: totals.input_tokens,
      outputTokens: totals.output_tokens,
      cost: totals.cost,
      byCaller,
    };
  }

  /** Check if daily budget is exhausted */
  isBudgetExhausted(): boolean {
    if (this.config.dailyBudget == null) return false;

    const midnight = todayMidnightUTC();
    const totals = this.sumTodayStmt.get(midnight) as { cost: number | null };
    if (totals.cost == null) return false;

    return totals.cost >= this.config.dailyBudget;
  }

  /** Get budget status for API responses */
  getBudgetStatus(): BudgetStatus {
    const midnight = todayMidnightUTC();
    const totals = this.sumTodayStmt.get(midnight) as { cost: number | null };
    const spent = totals.cost;

    return {
      dailyBudget: this.config.dailyBudget,
      spent,
      remaining:
        this.config.dailyBudget != null && spent != null
          ? Math.max(0, this.config.dailyBudget - spent)
          : null,
      exhausted: this.isBudgetExhausted(),
    };
  }

  /** Delegate backoff state to underlying provider */
  getBackoffState(): BackoffState | null {
    if (this.provider instanceof OpenAICompatibleProvider) {
      return this.provider.backoffState;
    }
    return null;
  }

  /** Prune records older than 365 days */
  pruneOldRecords(): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 365);
    const result = this.db.db
      .prepare("DELETE FROM llm_usage WHERE timestamp < ?")
      .run(cutoff.toISOString());
    if (result.changes > 0) {
      log.info(`Pruned ${result.changes} LLM usage records older than 365 days`);
    }
    return result.changes;
  }

  // --- Private ---

  private recordUsage(
    caller: string,
    inputTokens: number,
    outputTokens: number,
    tokenSource: "actual" | "estimated",
  ): void {
    const cost = this.calculateCost(inputTokens, outputTokens);

    this.insertStmt.run(
      randomUUID(),
      caller,
      new Date().toISOString(),
      inputTokens,
      outputTokens,
      tokenSource,
      cost.amount,
      cost.source,
      this.getModelName(),
    );
  }

  private calculateCost(inputTokens: number, outputTokens: number): { amount: number | null; source: string | null } {
    if (this.config.inputCostPerMillion != null && this.config.outputCostPerMillion != null) {
      const amount =
        (inputTokens * this.config.inputCostPerMillion) / 1_000_000 +
        (outputTokens * this.config.outputCostPerMillion) / 1_000_000;
      return { amount, source: "configured" };
    }
    return { amount: null, source: null };
  }

  private getModelName(): string {
    return this.provider.name ?? "unknown";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/usage/tracker.ts tests/usage/tracker.test.ts
git commit -m "feat: add UsageTracker — sole LLM gateway with cost tracking and budget enforcement"
```

---

### Task 4: Config Schema — Add `llmBudget` Section

**Files:**
- Modify: `core/config.ts`
- Modify: `config/default.yaml`
- Test: `tests/core/config.test.ts` (verify new config loads)

- [ ] **Step 1: Write the failing test**

Add to `tests/core/config.test.ts` (or create if needed — check what exists first):

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../core/config.js";

describe("llmBudget config", () => {
  it("loads default llmBudget with null values", () => {
    const config = loadConfig();
    expect(config.llmBudget).toBeDefined();
    expect(config.llmBudget.dailyBudget).toBeNull();
    expect(config.llmBudget.inputCostPerMillion).toBeNull();
    expect(config.llmBudget.outputCostPerMillion).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/config.test.ts`
Expected: FAIL — `config.llmBudget` is undefined

- [ ] **Step 3: Add llmBudget to the config schema**

In `core/config.ts`, add the schema after the existing `sidekick` schema (around line 80):

```typescript
  llmBudget: z.object({
    dailyBudget: z.number().nullable(),
    inputCostPerMillion: z.number().nullable(),
    outputCostPerMillion: z.number().nullable(),
  }).optional().default({
    dailyBudget: null,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
  }),
```

In `config/default.yaml`, add at the end:

```yaml
llmBudget:
  dailyBudget: null              # USD per day, null = unlimited
  inputCostPerMillion: null      # USD per 1M input tokens
  outputCostPerMillion: null     # USD per 1M output tokens
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (no existing tests broken)

- [ ] **Step 6: Commit**

```bash
git add core/config.ts config/default.yaml tests/core/config.test.ts
git commit -m "feat: add llmBudget config section with daily budget and cost-per-token settings"
```

---

### Task 5: Wire Classifier Through UsageTracker

**Files:**
- Modify: `core/classifier/index.ts`
- Modify: `core/server.ts` (bootstrap wiring)

The classifier currently holds a `ModelProvider` directly. We change it to accept a `UsageTracker` and delegate `classify()` through it.

- [ ] **Step 1: Write the failing test**

Add to `tests/usage/tracker.test.ts`:

```typescript
import { Classifier } from "../../core/classifier/index.js";

describe("Classifier with UsageTracker", () => {
  it("classify() goes through the tracker and records usage", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "in_progress", confidence: 0.9, reason: "working", workItemIds: ["AI-5"], title: "Build feature",
    });
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);
    const classifier = new Classifier(tracker, "You are a classifier.", [
      { role: "user", content: "example" },
      { role: "assistant", content: '{"status":"noise"}' },
    ]);

    const result = await classifier.classify("AI-5: still working on the feature");
    expect(result.status).toBe("in_progress");

    // Verify usage was recorded
    const rows = db.db.prepare("SELECT * FROM llm_usage").all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: FAIL — Classifier constructor doesn't accept UsageTracker

- [ ] **Step 3: Modify the Classifier to accept UsageTracker**

In `core/classifier/index.ts`, change the constructor and `classify()` to delegate through the tracker:

Replace the provider-related imports and class definition. The key changes:

1. Import `UsageTracker` alongside `ModelProvider`
2. The constructor accepts `ModelProvider | UsageTracker` — if it's a `UsageTracker`, call `tracker.classify()`. If it's a plain `ModelProvider`, call `provider.classify()` directly (backwards compat for tests using mock providers).
3. Move rate limiter `acquire()` out — the tracker handles budget; the rate limiter stays separate (it's about API throttling, not cost).

Replace the `classify` method in `core/classifier/index.ts`:

```typescript
import type { UsageTracker } from "../usage/tracker.js";
```

Change the private field and constructor:

```typescript
  private readonly provider: ModelProvider | UsageTracker;
```

The constructor signature stays the same (it accepts anything with a `classify` method).

Change the `classify()` method body:

```typescript
  async classify(message: string): Promise<Classification> {
    try {
      // Rate-limit LLM calls (API throttling — separate from budget)
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      let result;
      if ("completionCall" in this.provider) {
        // It's a UsageTracker — delegate through it
        result = await (this.provider as UsageTracker).classify(
          message,
          this.systemPrompt,
          this.fewShotMessages,
          "classifier",
        );
      } else {
        // Plain ModelProvider (tests, backwards compat)
        result = await this.provider.classify(
          message,
          this.systemPrompt,
          this.fewShotMessages,
        );
      }

      const status: StatusCategory = VALID_STATUSES.has(result.status)
        ? (result.status as StatusCategory)
        : "noise";

      const confidence = Math.max(0, Math.min(1, result.confidence));

      return {
        status,
        confidence,
        reason: result.reason,
        workItemIds: result.workItemIds,
        title: result.title,
      };
    } catch (error) {
      log.warn("Classification failed, returning default noise classification", error);
      return {
        status: "noise",
        confidence: 0.1,
        reason: "Classification failed — defaulting to noise",
        workItemIds: [],
        title: "",
      };
    }
  }
```

Also update `Classifier.fromConfig()` to create and return the tracker:

```typescript
  static fromConfig(config: Config, projectRoot?: string): { classifier: Classifier; tracker: UsageTracker } {
    const root = projectRoot ?? findProjectRoot();
    const prompt = loadPrompt(root);
    const provider = createProvider(config);
    const fewShot = buildFewShotMessages(prompt.few_shot_examples);
    // Note: tracker needs a Database, so we don't create it here.
    // Keep the old signature working for now — server.ts creates the tracker.
    return { classifier: new Classifier(provider, prompt.system, fewShot), tracker: null as any };
  }
```

Actually, this would break too many things. Simpler approach: keep `fromConfig` returning just a `Classifier` as before. The server's `main()` function creates the tracker separately and passes it. The `Classifier` constructor just needs to accept `UsageTracker` as the provider. Since `UsageTracker.classify()` has a different signature than `ModelProvider.classify()`, we use duck typing.

**Simpler approach:** Make `UsageTracker` implement `ModelProvider` interface by adding a `classify(message, systemPrompt, fewShot)` method that internally calls the tracked version. This way the Classifier doesn't need to change at all — it just receives a UsageTracker that looks like a ModelProvider.

Add to `core/usage/tracker.ts` — make the class implement `ModelProvider`:

```typescript
import type { ModelProvider, ClassificationResult } from "../classifier/providers/interface.js";

export class UsageTracker implements ModelProvider {
  readonly name: string;

  // ... existing constructor, but set this.name = provider.name ...

  /** ModelProvider interface — allows passing UsageTracker as a drop-in provider replacement */
  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult>;
```

Wait — the `classify` method signature collides. The spec has `classify(message, systemPrompt, fewShot, caller)` with 4 args, but `ModelProvider.classify` has 3 args.

**Best approach:** Make `UsageTracker` implement `ModelProvider` where the `caller` defaults to `"classifier"`:

```typescript
  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
    caller: string = "classifier",
  ): Promise<ClassificationResult> {
```

This way `UsageTracker` satisfies the `ModelProvider` interface (3 required args), and the Classifier constructor accepts it as a `ModelProvider` with zero changes.

- [ ] **Step 3 (revised): Update UsageTracker to implement ModelProvider**

In `core/usage/tracker.ts`, change the class declaration:

```typescript
export class UsageTracker implements ModelProvider {
  readonly name: string;
  private readonly provider: ModelProvider;
  private readonly db: Database;
  private config: UsageConfig;
  // ... prepared statements ...

  constructor(provider: ModelProvider, db: Database, config: UsageConfig) {
    this.name = provider.name;
    this.provider = provider;
    this.db = db;
    this.config = config;
    // ... prepare statements ...
  }

  /** Satisfies ModelProvider interface. caller defaults to "classifier". */
  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
    caller = "classifier",
  ): Promise<ClassificationResult> {
    // ... budget check, delegate to provider, record usage ...
  }
```

With this, the Classifier doesn't need any code changes — it receives a `UsageTracker` as its `ModelProvider` and calls `provider.classify(message, systemPrompt, fewShot)`. The tracker intercepts the call, checks budget, delegates to the real provider, records usage, and returns the result.

- [ ] **Step 4: Update server.ts bootstrap to wire the tracker**

In `core/server.ts`, in the `main()` function, after creating the provider and classifier:

```typescript
// After: const classifier = Classifier.fromConfig(config, projectRoot);
// Change to:
import { UsageTracker } from "./usage/tracker.js";

// In main():
const provider = createProvider(config);
const usageTracker = new UsageTracker(provider, db, config.llmBudget);
usageTracker.pruneOldRecords(); // Data retention: delete records older than 365 days

const root = findProjectRoot();
const prompt = loadPrompt(root); // Need to expose loadPrompt or refactor
```

Actually, `Classifier.fromConfig()` creates the provider internally. We need to split that. Instead, keep using `Classifier.fromConfig()` for creating the classifier, but then replace the provider inside it. Or better: create the provider and tracker explicitly in `main()`:

In `core/classifier/index.ts`, export `createProvider` and `loadPrompt` / `buildFewShotMessages` (they're already module-level functions, just need to be exported):

Add `export` to `loadPrompt` and `buildFewShotMessages`:

```typescript
export function loadPrompt(projectRoot: string): PromptConfig {
export function buildFewShotMessages(
```

Then in `core/server.ts` `main()`:

```typescript
import { createProvider, loadPrompt, buildFewShotMessages, Classifier } from "./classifier/index.js";
import { UsageTracker } from "./usage/tracker.js";

// In main():
const provider = createProvider(config);
const usageTracker = new UsageTracker(provider, db, config.llmBudget);
usageTracker.pruneOldRecords();

const prompt = loadPrompt(projectRoot);
const fewShot = buildFewShotMessages(prompt.few_shot_examples);
const classifier = new Classifier(usageTracker, prompt.system, fewShot);
```

Also update the `Classifier.fromConfig` static method to still work (for any other callers), but keep using the non-tracked path. This preserves backwards compatibility.

And in `EngineState`, add the tracker:

```typescript
export interface EngineState {
  // ... existing fields ...
  usageTracker: UsageTracker | null;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/usage/tracker.ts core/classifier/index.ts core/server.ts tests/usage/tracker.test.ts
git commit -m "feat: wire Classifier through UsageTracker for tracked LLM calls"
```

---

### Task 6: Wire Summarizer and Sidekick Through UsageTracker

**Files:**
- Modify: `core/summarizer/index.ts`
- Modify: `core/sidekick/index.ts`
- Modify: `core/server.ts` (pass tracker to summarizer and sidekick creation)

The summarizer and sidekick make raw `fetch()` calls. We replace `fetch()` with `tracker.completionCall()`.

- [ ] **Step 1: Modify Summarizer to accept and use UsageTracker**

In `core/summarizer/index.ts`, add an optional `usageTracker` to the config:

```typescript
import type { UsageTracker } from "../usage/tracker.js";

export interface SummarizerConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  usageTracker?: UsageTracker;
}
```

In the constructor, store it:

```typescript
  private readonly usageTracker?: UsageTracker;

  constructor(config: SummarizerConfig) {
    // ... existing ...
    this.usageTracker = config.usageTracker;
  }
```

In `callAnthropic` and `callOpenAI`, replace `fetch(url, ...)` with:

```typescript
    const response = this.usageTracker
      ? await this.usageTracker.completionCall(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }, "summarizer")
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
```

- [ ] **Step 2: Modify Sidekick to accept and use UsageTracker**

In `core/sidekick/index.ts`, add `usageTracker` to `SidekickConfig`:

```typescript
import type { UsageTracker } from "../usage/tracker.js";

export interface SidekickConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxToolCalls: number;
  usageTracker?: UsageTracker;
}
```

Store it and use it in `callAnthropic` and `callOpenAI`:

```typescript
  private readonly usageTracker?: UsageTracker;

  constructor(config: SidekickConfig, graph: ContextGraph) {
    // ... existing ...
    this.usageTracker = config.usageTracker;
  }
```

In both `callAnthropic` and `callOpenAI`, replace `fetch(url, ...)`:

```typescript
    const response = this.usageTracker
      ? await this.usageTracker.completionCall(url, { method: "POST", headers, body: JSON.stringify(...), signal: AbortSignal.timeout(60_000) }, "sidekick")
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(...), signal: AbortSignal.timeout(60_000) });
```

- [ ] **Step 3: Update server.ts to pass tracker when creating summarizer and sidekick**

In `core/server.ts`, the summarizer is created on-demand in `POST /api/work-item/:id/summarize`:

```typescript
    const summarizer = new Summarizer({ baseUrl, model, apiKey, usageTracker: state.usageTracker ?? undefined });
```

And the sidekick in `POST /api/sidekick`:

```typescript
    const sidekick = new Sidekick(
      { baseUrl, model, apiKey, maxToolCalls: sidekickConfig.maxToolCalls, usageTracker: state.usageTracker ?? undefined },
      state.graph,
    );
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: ALL PASS (existing summarizer and sidekick tests use mock providers without a tracker, so the optional tracker path is not exercised — but nothing breaks)

- [ ] **Step 5: Commit**

```bash
git add core/summarizer/index.ts core/sidekick/index.ts core/server.ts
git commit -m "feat: wire Summarizer and Sidekick through UsageTracker"
```

---

### Task 7: Pipeline Optimizations — Skip Unnecessary Classifications

**Files:**
- Modify: `core/pipeline.ts`
- Create: `tests/usage/pipeline-optimizations.test.ts`

Three optimizations: skip bot/system messages, skip duplicate content, skip completed work items.

- [ ] **Step 1: Write failing tests**

Create `tests/usage/pipeline-optimizations.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { Pipeline } from "../../core/pipeline.js";
import type { Classification, Message } from "../../core/types.js";

function setup() {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifyFn = vi.fn().mockResolvedValue({
    status: "in_progress", confidence: 0.9, reason: "working", workItemIds: [], title: "test",
  });
  const classifier = new Classifier(
    { name: "mock", classify: classifyFn },
    "sys", [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [] }),
  ]);

  // Create a mock messaging adapter (not used for polling in these tests)
  const adapter = { name: "test", displayName: "Test" } as any;
  const pipeline = new Pipeline(adapter, classifier, graph, linker);

  return { db, graph, classifier, classifyFn, linker, pipeline };
}

describe("Pipeline optimizations", () => {
  it("skips classification when work item is completed", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    // Set up a completed work item with a linked thread
    graph.upsertWorkItem({ id: "AI-100", source: "jira", currentAtcStatus: "completed" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "test", workItemId: "AI-100" });

    const msg: Message = {
      id: "m-new",
      text: "AI-100: Confirming deployment is stable",
      userId: "u1",
      userName: "Byte",
      platform: "test",
      timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg, "t1", "C1");

    // Classifier should NOT have been called
    expect(classifyFn).not.toHaveBeenCalled();
    db.close();
  });

  it("skips classification for duplicate message content within same work item", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    graph.upsertWorkItem({ id: "AI-200", source: "jira" });
    graph.upsertThread({ id: "t2", channelId: "C1", platform: "test", workItemId: "AI-200" });

    const msg1: Message = {
      id: "m1", text: "Still working on AI-200...", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };
    const msg2: Message = {
      id: "m2", text: "Still working on AI-200...", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg1, "t2", "C1");
    await pipeline.processMessage(msg2, "t2", "C1");

    // Classifier should have been called only once (second was deduped)
    expect(classifyFn).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("classifies normally when work item is not completed", async () => {
    const { db, graph, classifyFn, pipeline } = setup();

    graph.upsertWorkItem({ id: "AI-300", source: "jira", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t3", channelId: "C1", platform: "test", workItemId: "AI-300" });

    const msg: Message = {
      id: "m3", text: "AI-300: Need approval for this PR", userId: "u1", userName: "Byte",
      platform: "test", timestamp: new Date().toISOString(),
    };

    await pipeline.processMessage(msg, "t3", "C1");
    expect(classifyFn).toHaveBeenCalledTimes(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/pipeline-optimizations.test.ts`
Expected: FAIL — "skips classification when work item is completed" fails because the classifier is still called

- [ ] **Step 3: Add skip logic to Pipeline.processMessageInternal()**

In `core/pipeline.ts`, in `processMessageInternal()`, after the existing "already-processed" check (Step 0) and the "inherit work item" step (Step 0b), add:

```typescript
    // Step 0c: Skip classification if the work item is already completed
    // (operator already acted — new messages don't need classification)
    if (inheritedWorkItemId) {
      const existingWI = this.graph.getWorkItemById(inheritedWorkItemId);
      if (existingWI?.currentAtcStatus === "completed") {
        log.debug("Skipping classification for completed work item", inheritedWorkItemId);
        return {
          status: "noise",
          confidence: 0,
          reason: "Work item already completed — skipping classification",
          workItemIds: [inheritedWorkItemId],
          title: "",
        };
      }
    }

    // Step 0d: Skip classification for duplicate message content
    // (agents posting identical status updates within the same thread)
    const contentHash = this.getContentHash(message.text, thread.id);
    if (this.recentContentHashes.has(contentHash)) {
      log.debug("Skipping duplicate message content", message.id);
      const cachedResult = this.recentContentHashes.get(contentHash)!;
      // Still insert the event with the cached classification
      this.graph.upsertAgent({
        id: message.userId,
        name: message.userName,
        platform: message.platform,
        platformUserId: message.userId,
        avatarUrl: message.userAvatarUrl ?? null,
      });
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
      });
      return cachedResult;
    }
```

Add the content hash cache as a class field:

```typescript
  private recentContentHashes = new Map<string, Classification>();
  private readonly CONTENT_HASH_TTL_MS = 60 * 60 * 1000; // 1 hour
  private readonly MAX_CONTENT_HASHES = 1000;
```

Add the helper method:

```typescript
  private getContentHash(text: string, threadId: string): string {
    // Simple hash using built-in crypto
    const { createHash } = require("node:crypto");
    return createHash("sha256").update(`${threadId}:${text}`).digest("hex");
  }
```

And after a successful classification (after Step 2), cache the result:

```typescript
    // Cache the classification for deduplication
    const hash = this.getContentHash(message.text, thread.id);
    this.recentContentHashes.set(hash, classification);
    // Prune old entries if cache is too large
    if (this.recentContentHashes.size > this.MAX_CONTENT_HASHES) {
      const firstKey = this.recentContentHashes.keys().next().value;
      if (firstKey) this.recentContentHashes.delete(firstKey);
    }
```

Add the crypto import at the top of the file:

```typescript
import { createHash } from "node:crypto";
```

And update the `getContentHash` method to use the import:

```typescript
  private getContentHash(text: string, threadId: string): string {
    return createHash("sha256").update(`${threadId}:${text}`).digest("hex");
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/usage/pipeline-optimizations.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/pipeline.ts tests/usage/pipeline-optimizations.test.ts
git commit -m "feat: skip unnecessary LLM classifications for completed items and duplicate messages"
```

---

### Task 8: Server API — Expose Usage in Status + Accept Budget Config

**Files:**
- Modify: `core/server.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add `llmUsage` to GET /api/status response**

In `core/server.ts`, in the `GET /api/status` handler, add:

```typescript
    // LLM usage tracking
    const llmUsage = state.usageTracker
      ? (() => {
          const today = state.usageTracker.getTodayUsage();
          const budget = state.usageTracker.getBudgetStatus();
          return {
            inputTokens: today.inputTokens,
            outputTokens: today.outputTokens,
            cost: today.cost,
            costSource: today.cost != null ? "configured" as const : null,
            dailyBudget: budget.dailyBudget,
            exhausted: budget.exhausted,
          };
        })()
      : null;
```

Add `llmUsage` to the returned JSON object.

- [ ] **Step 2: Accept budget config in POST /api/setup**

In the `POST /api/setup` handler, after the existing LLM section, add handling for budget fields:

```typescript
      // --- LLM Budget ---
      if (body.llm) {
        if (body.llm.dailyBudget !== undefined) {
          (localConfig as any).llmBudget = {
            dailyBudget: body.llm.dailyBudget,
            inputCostPerMillion: body.llm.inputCostPerMillion ?? null,
            outputCostPerMillion: body.llm.outputCostPerMillion ?? null,
          };
        }
      }
```

And after config reload, update the tracker:

```typescript
      if (state.usageTracker) {
        state.usageTracker.updateConfig(state.config.llmBudget);
      }
```

- [ ] **Step 3: Include budget in GET /api/setup/prefill**

In the prefill response, add budget fields to the `llm` section:

```typescript
    result.llm = {
      apiKey: process.env.ATC_LLM_API_KEY ?? "",
      baseUrl: process.env.ATC_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      model: process.env.ATC_LLM_MODEL ?? "claude-sonnet-4-6",
      dailyBudget: state.config.llmBudget?.dailyBudget ?? null,
      inputCostPerMillion: state.config.llmBudget?.inputCostPerMillion ?? null,
      outputCostPerMillion: state.config.llmBudget?.outputCostPerMillion ?? null,
    };
```

- [ ] **Step 4: Update frontend types in src/lib/api.ts**

Add `llmUsage` to `EngineStatus`:

```typescript
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  costSource: "api" | "configured" | null;
  dailyBudget: number | null;
  exhausted: boolean;
}

export interface EngineStatus {
  ok: boolean;
  uptime: number;
  pipeline: unknown;
  services: ServiceStatuses;
  llmBackoff: LlmBackoff | null;
  llmUsage: LlmUsage | null;
}
```

Add budget fields to `SetupPayload.llm`:

```typescript
export interface SetupPayload {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dailyBudget?: number | null;
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
  };
  rateLimits?: Record<string, number>;
}
```

Add budget fields to `SetupPrefill.llm`:

```typescript
export interface SetupPrefill {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dailyBudget?: number | null;
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
  };
  rateLimits?: Record<string, RateLimitInfo>;
}
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add core/server.ts src/lib/api.ts
git commit -m "feat: expose LLM usage in status API and accept budget config in setup"
```

---

### Task 9: Setup Page — Budget Fields in LLM Section

**Files:**
- Modify: `src/components/Setup.tsx`

- [ ] **Step 1: Add state for budget fields**

In `Setup.tsx`, add state variables after the existing LLM state:

```typescript
  // LLM Budget
  const [dailyBudget, setDailyBudget] = useState<string>("");
  const [inputCostPerMillion, setInputCostPerMillion] = useState<string>("");
  const [outputCostPerMillion, setOutputCostPerMillion] = useState<string>("");
```

- [ ] **Step 2: Prefill budget values**

In the `useEffect` that handles prefill, after the existing `prefill.llm` block, add:

```typescript
          if (prefill.llm.dailyBudget != null) setDailyBudget(String(prefill.llm.dailyBudget));
          if (prefill.llm.inputCostPerMillion != null) setInputCostPerMillion(String(prefill.llm.inputCostPerMillion));
          if (prefill.llm.outputCostPerMillion != null) setOutputCostPerMillion(String(prefill.llm.outputCostPerMillion));
```

- [ ] **Step 3: Add budget fields to the LLM fieldset**

After the Base URL input (the closing `</div>` before `</fieldset>` of the LLM section), add:

```tsx
          {/* ── Budget (optional) ─── */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="dailyBudget" className="text-xs text-gray-400 mb-1 block">
                Daily Budget ($)
              </label>
              <input
                id="dailyBudget"
                type="number"
                step="0.01"
                min="0"
                value={dailyBudget}
                onChange={(e) => setDailyBudget(e.target.value)}
                placeholder="20.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="inputCost" className="text-xs text-gray-400 mb-1 block">
                Input $/1M tok
              </label>
              <input
                id="inputCost"
                type="number"
                step="0.01"
                min="0"
                value={inputCostPerMillion}
                onChange={(e) => setInputCostPerMillion(e.target.value)}
                placeholder="3.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="outputCost" className="text-xs text-gray-400 mb-1 block">
                Output $/1M tok
              </label>
              <input
                id="outputCost"
                type="number"
                step="0.01"
                min="0"
                value={outputCostPerMillion}
                onChange={(e) => setOutputCostPerMillion(e.target.value)}
                placeholder="15.00"
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-600">
            Leave empty if your API returns cost data, or if you don't need cost tracking.
          </p>
```

- [ ] **Step 4: Include budget in submit payload**

In `handleSubmit`, update the `payload.llm` assignment:

```typescript
      payload.llm = {
        apiKey: keyValue.trim(),
        baseUrl: llmBaseUrl.trim() || PRESETS.anthropic.baseUrl,
        model: llmModel.trim() || PRESETS.anthropic.models[0],
        dailyBudget: dailyBudget ? parseFloat(dailyBudget) : null,
        inputCostPerMillion: inputCostPerMillion ? parseFloat(inputCostPerMillion) : null,
        outputCostPerMillion: outputCostPerMillion ? parseFloat(outputCostPerMillion) : null,
      };
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/Setup.tsx
git commit -m "feat: add daily budget and cost-per-token fields to LLM setup section"
```

---

### Task 10: Status Bar — Display Cost Next to LLM Indicator

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add llmUsage to the status polling state**

In `App.tsx`, update `checkConnection` to also store `llmUsage`:

```typescript
  const [llmUsage, setLlmUsage] = useState<import("./lib/api").LlmUsage | null>(null);
```

In `checkConnection`:

```typescript
      const status = await fetchStatus();
      setConnected(true);
      setServices(status.services);
      setLlmUsage(status.llmUsage ?? null);
```

Import `LlmUsage` from api:

```typescript
import { fetchSetupStatus, fetchStatus, type ServiceStatuses, type LlmUsage } from "./lib/api";
```

- [ ] **Step 2: Update the LLM ServiceDot to show cost**

In the service indicators area, the LLM dot is rendered by the generic `Object.entries(services).map(...)`. We need to augment the LLM entry specifically. After the existing service dots mapping, add a cost label:

```tsx
          {llmUsage?.cost != null && (
            <span className="text-[11px] text-gray-500">
              ${llmUsage.cost.toFixed(2)}
              {llmUsage.dailyBudget != null && ` / $${llmUsage.dailyBudget.toFixed(2)}`}
              {llmUsage.exhausted && (
                <span className="text-amber-500"> (paused)</span>
              )}
            </span>
          )}
```

Place this inside the service indicators `<div>`, after the `Object.entries(services).map(...)` block.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: display LLM daily cost and budget in status bar"
```

---

### Task 11: Data Retention — Prune on Startup

**Files:**
- Modify: `core/server.ts` (already handled in Task 5, verify it's there)
- Test: Add a test for `pruneOldRecords()`

- [ ] **Step 1: Write a test for data retention**

Add to `tests/usage/tracker.test.ts`:

```typescript
describe("Data retention", () => {
  it("prunes records older than 365 days", () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "noise", confidence: 0.8, reason: "x", workItemIds: [], title: "",
    });
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);

    // Insert an old record directly
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 400);
    db.db.prepare(`
      INSERT INTO llm_usage (id, caller, timestamp, input_tokens, output_tokens, token_source, cost, cost_source, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-1", "classifier", oldDate.toISOString(), 100, 50, "estimated", 0.001, "configured", "test");

    // Insert a recent record
    db.db.prepare(`
      INSERT INTO llm_usage (id, caller, timestamp, input_tokens, output_tokens, token_source, cost, cost_source, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("new-1", "classifier", new Date().toISOString(), 100, 50, "estimated", 0.001, "configured", "test");

    const pruned = tracker.pruneOldRecords();
    expect(pruned).toBe(1);

    const remaining = db.db.prepare("SELECT COUNT(*) AS n FROM llm_usage").get() as { n: number };
    expect(remaining.n).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/usage/tracker.test.ts`
Expected: PASS (pruneOldRecords was already implemented in Task 3)

- [ ] **Step 3: Verify pruneOldRecords() is called in server.ts main()**

Confirm that `usageTracker.pruneOldRecords()` is called during bootstrap (added in Task 5). If not, add it after tracker creation in `main()`.

- [ ] **Step 4: Commit**

```bash
git add tests/usage/tracker.test.ts
git commit -m "test: add data retention test for LLM usage pruning"
```

---

### Task 12: Final Integration Test

**Files:**
- Modify: `tests/server/setup-api.test.ts`

- [ ] **Step 1: Add a test for llmUsage in GET /api/status**

Add to `tests/server/setup-api.test.ts`:

```typescript
describe("GET /api/status — llmUsage", () => {
  it("returns null llmUsage when no tracker configured", async () => {
    const state = makeState();
    const app = createApp(state);
    const res = await app.request("/api/status");
    const body = await res.json();

    // llmUsage should be null when no tracker is on the state
    expect(body.llmUsage).toBeNull();
    state.db.close();
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/server/setup-api.test.ts
git commit -m "test: verify llmUsage field in status API response"
```
