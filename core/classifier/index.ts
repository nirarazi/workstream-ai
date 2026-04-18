// core/classifier/index.ts — Classifier orchestrator

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logger.js";
import { findProjectRoot, type Config } from "../config.js";
import type { Classification, EntryType, StatusCategory } from "../types.js";
import { OpenAICompatibleProvider, type BackoffState } from "./providers/openai-compatible.js";
import type { ModelProvider } from "./providers/interface.js";
import type { RateLimiter } from "../rate-limiter.js";

const log = createLogger("classifier");

function inferEntryType(status: StatusCategory): EntryType {
  switch (status) {
    case "blocked_on_human":
    case "needs_decision":
      return "block";
    case "noise":
      return "noise";
    default:
      return "progress";
  }
}

const VALID_STATUSES: Set<string> = new Set([
  "completed",
  "in_progress",
  "blocked_on_human",
  "needs_decision",
  "noise",
]);

export interface PromptConfig {
  system: string;
  few_shot_examples: Array<{
    role: string;
    content: string;
    expected: Record<string, unknown>;
  }>;
}

export function loadPrompt(projectRoot: string): PromptConfig {
  const promptPath = resolve(projectRoot, "config", "prompts", "classify.yaml");
  const raw = readFileSync(promptPath, "utf-8");
  return parseYaml(raw) as PromptConfig;
}

export function buildFewShotMessages(
  examples: PromptConfig["few_shot_examples"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  for (const ex of examples) {
    messages.push({ role: "user", content: ex.content });
    messages.push({
      role: "assistant",
      content: JSON.stringify(ex.expected),
    });
  }
  return messages;
}

export function buildOperatorContext(config: Config): string {
  const name = (config as any).operator?.name ?? "";
  const context = (config as any).operator?.context ?? "";
  if (!name && !context) return "";
  const parts: string[] = [];
  if (name) parts.push(`The operator's name is ${name}.`);
  if (context) parts.push(context);
  return parts.join("\n");
}

export function createProvider(config: Config): ModelProvider {
  const { baseUrl, model, apiKey } = config.classifier.provider;
  const isAnthropic = baseUrl.includes("anthropic");
  const name = isAnthropic ? "anthropic" : "openai-compatible";
  return new OpenAICompatibleProvider({ name, baseUrl, model, apiKey });
}

export class Classifier {
  private readonly provider: ModelProvider;
  private readonly systemPrompt: string;
  private readonly fewShotMessages: Array<{ role: string; content: string }>;
  private readonly operatorContext: string;
  private rateLimiter?: RateLimiter;

  constructor(provider: ModelProvider, systemPrompt: string, fewShotMessages: Array<{ role: string; content: string }>, rateLimiter?: RateLimiter, operatorContext?: string) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.fewShotMessages = fewShotMessages;
    this.rateLimiter = rateLimiter;
    this.operatorContext = operatorContext ?? "";
  }

  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  getBackoffState(): BackoffState | null {
    if (this.provider instanceof OpenAICompatibleProvider) {
      return this.provider.backoffState;
    }
    return null;
  }

  static fromConfig(config: Config, projectRoot?: string): Classifier {
    const root = projectRoot ?? findProjectRoot();
    const prompt = loadPrompt(root);
    const provider = createProvider(config);
    const fewShot = buildFewShotMessages(prompt.few_shot_examples);
    const operatorContext = buildOperatorContext(config);
    return new Classifier(provider, prompt.system, fewShot, undefined, operatorContext);
  }

  async classify(message: string, openWorkItems?: Array<{ id: string; title: string }>): Promise<Classification> {
    try {
      // Rate-limit LLM calls
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      let effectiveSystemPrompt = this.systemPrompt;

      if (this.operatorContext) {
        effectiveSystemPrompt += `\n\n## Operator Context\n\n${this.operatorContext}`;
      }

      if (openWorkItems && openWorkItems.length > 0) {
        const itemLines = openWorkItems.map(wi => `- ${wi.id}: ${wi.title}`).join("\n");
        effectiveSystemPrompt += `\n\n## Open Work Items\n\nBelow are currently open work items. If the message is about the same topic as an existing item, return that item's ID in workItemIds instead of leaving it empty. This prevents duplicate work items.\n\n${itemLines}`;
      }

      const result = await this.provider.classify(
        message,
        effectiveSystemPrompt,
        this.fewShotMessages,
      );

      const status: StatusCategory = VALID_STATUSES.has(result.status)
        ? (result.status as StatusCategory)
        : "noise";

      const confidence = Math.max(0, Math.min(1, result.confidence));

      return {
        status,
        entryType: (result as { entry_type?: string }).entry_type as EntryType ?? inferEntryType(status),
        confidence,
        reason: result.reason,
        workItemIds: result.workItemIds,
        title: result.title,
        targetedAtOperator: result.targeted_at_operator !== false,
        breakdown: result.breakdown?.map((b) => {
          const bStatus = (VALID_STATUSES.has(b.status) ? b.status : "noise") as StatusCategory;
          return {
            workItemId: b.workItemId,
            status: bStatus,
            entryType: (b as { entry_type?: string }).entry_type as EntryType ?? inferEntryType(bStatus),
            confidence: Math.max(0, Math.min(1, b.confidence)),
            reason: b.reason,
            title: b.title,
            targetedAtOperator: b.targeted_at_operator !== false,
          };
        }),
      };
    } catch (error) {
      log.warn("Classification failed, returning default noise classification", error);
      return {
        status: "noise",
        entryType: "noise",
        confidence: 0.1,
        reason: "Classification failed — defaulting to noise",
        workItemIds: [],
        title: "",
        targetedAtOperator: true,
      };
    }
  }
}
