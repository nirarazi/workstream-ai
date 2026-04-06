import { describe, it, expect } from "vitest";
import type { UsageRecord, DailyUsage, BudgetStatus, UsageConfig } from "../../core/usage/types.js";
import { Database } from "../../core/graph/db.js";

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
