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
