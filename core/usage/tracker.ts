// core/usage/tracker.ts — Sole gateway for all LLM calls. Records usage, calculates cost, enforces daily budget.

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { ModelProvider, ClassificationResult } from "../classifier/providers/interface.js";
import type { BackoffState } from "../classifier/providers/openai-compatible.js";
import { OpenAICompatibleProvider } from "../classifier/providers/openai-compatible.js";
import type { Database } from "../graph/db.js";
import type { DailyUsage, BudgetStatus, UsageConfig } from "./types.js";

const log = createLogger("usage-tracker");

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Minimum token overhead per API call to account for request JSON structure,
 * role/message wrapping, and model context overhead not captured in raw text.
 */
const MIN_INPUT_TOKEN_OVERHEAD = 100;
const MIN_OUTPUT_TOKEN_OVERHEAD = 50;

function todayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export class UsageTracker implements ModelProvider {
  readonly name: string;
  private readonly provider: ModelProvider;
  private readonly db: Database;
  private config: UsageConfig;

  private readonly insertStmt;
  private readonly sumTodayStmt;
  private readonly sumByCallerStmt;

  constructor(provider: ModelProvider, db: Database, config: UsageConfig) {
    this.name = provider.name;
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
    caller = "classifier",
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

    // Estimate tokens (provider doesn't expose usage data via the classify interface).
    // Add per-call overhead for request JSON structure, role/message wrapping, etc.
    const fewShotText = fewShotExamples.map((e) => e.content).join("");
    const inputTokens = estimateTokens(systemPrompt + fewShotText + message) + MIN_INPUT_TOKEN_OVERHEAD;
    const outputTokens = estimateTokens(JSON.stringify(result)) + MIN_OUTPUT_TOKEN_OVERHEAD;

    this.recordUsage(caller, inputTokens, outputTokens, "estimated");

    return result;
  }

  /**
   * Make a completion call — wraps fetch() with tracking and budget enforcement.
   * Used by summarizer and sidekick. Returns the Response object.
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

  /** Abort all in-flight LLM calls (e.g. when provider config changes) */
  abort(): void {
    if (this.provider instanceof OpenAICompatibleProvider) {
      this.provider.abort();
    }
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
