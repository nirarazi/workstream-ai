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
