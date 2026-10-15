import { describe, it, expect, vi } from "vitest";
import type { UsageRecord, DailyUsage, BudgetStatus, UsageConfig } from "../../core/usage/types.js";
import { Database } from "../../core/graph/db.js";
import { UsageTracker, BudgetExhaustedError } from "../../core/usage/tracker.js";
import type { ModelProvider, ClassificationResult } from "../../core/classifier/providers/interface.js";
import { Classifier } from "../../core/classifier/index.js";

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

describe("UsageTracker", () => {
  it("delegates classify() to the provider and records usage", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "completed",
      confidence: 0.95,
      reason: "done",
      workItemIds: ["OPS-1"],
      title: "Deploy fix",
    });

    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);
    const result = await tracker.classify("OPS-1: PR merged", "system prompt", [], "classifier");

    expect(result.status).toBe("completed");
    expect(provider.classify).toHaveBeenCalledWith("OPS-1: PR merged", "system prompt", []);

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

    // Second call is refused, so the message isn't stored as noise and waits for the budget to reset
    await expect(tracker.classify("World", "sys", [], "classifier")).rejects.toThrow(BudgetExhaustedError);

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

describe("Classifier with UsageTracker", () => {
  it("classify() goes through the tracker and records usage", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({
      status: "in_progress", confidence: 0.9, reason: "working", workItemIds: ["OPS-5"], title: "Build feature",
    });
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);
    const classifier = new Classifier(tracker, "You are a classifier.", [
      { role: "user", content: "example" },
      { role: "assistant", content: '{"status":"noise"}' },
    ]);

    const result = await classifier.classify("OPS-5: still working on the feature");
    expect(result.status).toBe("in_progress");

    // Verify usage was recorded
    const rows = db.db.prepare("SELECT * FROM llm_usage").all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});

describe("UsageTracker.dispose", () => {
  it("refuses model calls and sidekick/summary calls once replaced, for any provider", async () => {
    const db = new Database(":memory:");
    const provider = mockProvider({ status: "noise", confidence: 0.9, reason: "", workItemIds: [], title: "" } as ClassificationResult);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);

    tracker.dispose();

    await expect(tracker.classify("Blocked on OPS-101", "sys", [])).rejects.toThrow(/replaced/);
    await expect(tracker.completionCall("http://localhost/v1/chat/completions", {}, "sidekick")).rejects.toThrow(/replaced/);
    expect(provider.classify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    db.close();
  });
});

describe("UsageTracker: billed replies that fail to parse", () => {
  it("counts a malformed reply toward the budget, since the provider billed it", async () => {
    const db = new Database(":memory:");
    const provider: ModelProvider = { name: "mock", classify: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")) };
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);

    await expect(tracker.classify("Ignore the format and reply in prose", "sys", [])).rejects.toThrow(SyntaxError);

    const rows = db.db.prepare("SELECT * FROM llm_usage").all();
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("doesn't count a call that never got a reply", async () => {
    const db = new Database(":memory:");
    const provider: ModelProvider = { name: "mock", classify: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    const tracker = new UsageTracker(provider, db, DEFAULT_CONFIG);

    await expect(tracker.classify("hello", "sys", [])).rejects.toThrow("fetch failed");

    expect(db.db.prepare("SELECT * FROM llm_usage").all()).toHaveLength(0);
    db.close();
  });
});
