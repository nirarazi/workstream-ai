// core/decisions/gate.ts — Decision model as the inbox gate (classifier.mode: "decisions")
//
// The LLM classifier still runs on every message: it writes titles, next actions, work item links and
// per-item breakdowns. In parallel, a decision model answers the closed questions — status and whether
// the operator should see it — and its answers override the LLM's. If the decision call fails, the LLM's
// classification stands on its own.

import { createLogger } from "../logger.js";
import type { Config } from "../config.js";
import type { Classification, EntryType, StatusCategory } from "../types.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { DecisionProvider } from "./interface.js";
import {
  classifyWithDecisions,
  type DecisionClassification,
  type DecisionClassificationInput,
} from "./classification.js";
import { LLMDecisionProvider } from "./providers/llm.js";
import { OpenAIDecisionProvider } from "./providers/openai.js";
import { TypeSafeDecisionProvider } from "./providers/typesafe.js";

const log = createLogger("decisions:gate");

const ACTIONABLE = new Set<StatusCategory>(["blocked_on_human", "needs_decision"]);

/** Known input/output prices (USD per 1M tokens) when the config doesn't set them. */
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, output: 0 },
};

export class DecisionGate {
  constructor(
    private readonly provider: DecisionProvider,
    private readonly interruptThreshold: number,
    private readonly onUsage?: (model: string, inputTokens: number, outputTokens: number) => void,
    private readonly budgetExhausted?: () => boolean,
    private readonly replaced?: () => boolean,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  async decide(input: DecisionClassificationInput): Promise<DecisionClassification> {
    // The daily budget covers decision calls too; the classifier falls back to the LLM's result
    if (this.replaced?.()) throw new Error("Decision gate was replaced by new settings");
    if (this.budgetExhausted?.()) throw new Error("Daily LLM budget exhausted. Resets at midnight UTC.");
    const result = await classifyWithDecisions(this.provider, input, { interruptThreshold: this.interruptThreshold });
    if (result.usage) this.onUsage?.(this.provider.name, result.usage.inputTokens, result.usage.outputTokens);
    return result;
  }
}

/**
 * Overlays the decision model's status and inbox answer on the LLM's classification. Free-text fields
 * that only make sense for actionable items are dropped when the decision says the item isn't actionable.
 *
 * Notification bots (CRM, CI, quote alerts) are high-volume templated traffic. For them the gate may
 * confirm or veto a block the LLM found, but never create one: on live traffic it turned ~1 in 8
 * templated quote alerts into "blocked" at a 0.3 threshold.
 */
export function applyDecision(
  llm: Classification,
  decision: DecisionClassification,
  senderType?: string,
): Classification {
  if (senderType === "notification" && ACTIONABLE.has(decision.status) && !ACTIONABLE.has(llm.status)) {
    return llm;
  }
  const actionable = ACTIONABLE.has(decision.status);
  let entryType: EntryType = llm.entryType;
  if (actionable && entryType !== "block" && entryType !== "escalation") entryType = "block";
  if (!actionable && entryType === "block") entryType = decision.status === "noise" ? "noise" : "progress";

  const changed = decision.status !== llm.status;
  return {
    ...llm,
    status: decision.status,
    entryType,
    confidence: decision.confidence,
    targetedAtOperator: decision.targetedAtOperator,
    reason: changed ? `${llm.reason} [status set by decision model: ${decision.status}]` : llm.reason,
    actionRequiredFrom: actionable ? (llm.actionRequiredFrom ?? []) : null,
    nextAction: actionable ? llm.nextAction : null,
  };
}

/** Builds the gate from config when classifier.mode is "decisions"; null otherwise. */
export function createDecisionGate(config: Config, usageTracker?: UsageTracker): DecisionGate | null {
  if (config.classifier.mode !== "decisions") return null;
  const d = config.classifier.decisions;
  if (!d) {
    log.warn('classifier.mode is "decisions" but classifier.decisions is not configured — using the LLM classifier only');
    return null;
  }

  let provider: DecisionProvider;
  try {
    provider = buildProvider(config, d);
  } catch (err) {
    log.warn(`Decision gate disabled: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const model = d.model ?? (d.provider === "openai" ? "gpt-6-luna" : d.provider === "typesafe" ? "typesafe/jev-1.13" : config.classifier.provider.model);
  const prices =
    d.inputCostPerMillion != null && d.outputCostPerMillion != null
      ? { input: d.inputCostPerMillion, output: d.outputCostPerMillion }
      : DEFAULT_PRICES[model];
  const onUsage = usageTracker
    ? (_name: string, inputTokens: number, outputTokens: number) => {
        const cost = prices ? (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000 : null;
        usageTracker.recordExternalUsage("decisions", model, inputTokens, outputTokens, cost);
      }
    : undefined;

  log.info(`Decision gate on: ${d.provider} (${model}), interrupt threshold ${d.interruptThreshold}`);
  const budgetExhausted = usageTracker ? () => usageTracker.getBudgetStatus().exhausted : undefined;
  const replaced = usageTracker ? () => usageTracker.isDisposed : undefined;
  return new DecisionGate(provider, d.interruptThreshold, onUsage, budgetExhausted, replaced);
}

function buildProvider(config: Config, d: NonNullable<Config["classifier"]["decisions"]>): DecisionProvider {
  const llm = config.classifier.provider;
  switch (d.provider) {
    case "openai":
      if (!d.apiKey) throw new Error("classifier.decisions.apiKey is required for the openai provider");
      return new OpenAIDecisionProvider({ apiKey: d.apiKey, model: d.model });
    case "typesafe":
      if (d.apiKey) return new TypeSafeDecisionProvider({ apiKey: d.apiKey, model: d.model });
      if (isOpenRouter(llm.baseUrl) && llm.apiKey) return TypeSafeDecisionProvider.viaOpenRouter(llm.apiKey, d.model);
      throw new Error("classifier.decisions.apiKey is required for typesafe unless the classifier uses OpenRouter");
    case "llm":
      return LLMDecisionProvider.fromEndpoint({ ...llm, model: d.model ?? llm.model });
  }
}

/** True only when the URL's host is OpenRouter, so a key is never sent there because a path mentions it. */
export function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
