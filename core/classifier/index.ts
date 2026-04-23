// core/classifier/index.ts — Classifier orchestrator

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logger.js";
import { findProjectRoot, type Config } from "../config.js";
import type { Classification, EntryType, OperatorIdentityMap, StatusCategory } from "../types.js";
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
  const name = config.operator?.name ?? "";
  const context = config.operator?.context ?? "";
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
  private readonly operatorRole: string;
  private readonly operatorIdentities: OperatorIdentityMap | null;
  private readonly operatorContext: string;
  private rateLimiter?: RateLimiter;

  constructor(
    provider: ModelProvider,
    systemPrompt: string,
    fewShotMessages: Array<{ role: string; content: string }>,
    rateLimiter?: RateLimiter,
    operatorRole?: string,
    operatorIdentities?: OperatorIdentityMap | null,
    operatorContext?: string,
  ) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.fewShotMessages = fewShotMessages;
    this.rateLimiter = rateLimiter;
    this.operatorRole = operatorRole ?? "";
    this.operatorIdentities = operatorIdentities ?? null;
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
    const operatorRole = config.operator?.role ?? "";
    return new Classifier(provider, prompt.system, fewShot, undefined, operatorRole, null, operatorContext);
  }

  async classify(
    message: string,
    openWorkItems?: Array<{ id: string; title: string }>,
    operatorIdentities?: OperatorIdentityMap | null,
    senderContext?: { senderName: string; senderType: string; channelName: string },
    validIdPrefixes?: string[],
  ): Promise<Classification> {
    try {
      // Rate-limit LLM calls
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      const effectiveIdentities = operatorIdentities ?? this.operatorIdentities;

      let effectiveSystemPrompt = this.systemPrompt;

      // Build operator profile block if identities are available
      if (effectiveIdentities && effectiveIdentities.size > 0) {
        const firstIdentity = [...effectiveIdentities.values()][0];
        const platformPairs = [...effectiveIdentities.entries()]
          .map(([platform, id]) => `${platform}:${id.userId}`)
          .join(", ");

        let profileBlock = `\n\n## Operator Profile\n\nName: ${firstIdentity.userName}\nPlatform identities: ${platformPairs}`;
        if (this.operatorRole) {
          profileBlock += `\nRole: ${this.operatorRole}`;
        }
        if (this.operatorContext) {
          profileBlock += `\n\n${this.operatorContext}`;
        }
        profileBlock += `\n\nWhen classifying targeted_at_operator, consider: would this item belong in the operator's inbox? Return true if:
- The operator is explicitly mentioned or addressed
- An agent is blocked and needs human intervention (the operator is the fleet's backstop)
- The issue is within the operator's stated remit

Return false if:
- The block is on an external party (client, vendor) with no operator action possible
- Another human is handling it and hasn't escalated
- It's a status report about someone else's block with no request to intervene`;

        effectiveSystemPrompt += profileBlock;
      } else if (this.operatorContext) {
        effectiveSystemPrompt += `\n\n## Operator Context\n\n${this.operatorContext}`;
      }

      if (validIdPrefixes && validIdPrefixes.length > 0) {
        effectiveSystemPrompt += `\n\n## Valid Work Item ID Prefixes\n\nThe following prefixes are the ONLY valid work item ID patterns: ${validIdPrefixes.join(", ")}. Only return IDs in workItemIds that match one of these prefixes. IDs like "Q-123" or "CRM-456" that don't match a known prefix should NOT be included in workItemIds — they are external reference numbers, not tracked work items.`;
      }

      if (openWorkItems && openWorkItems.length > 0) {
        const itemLines = openWorkItems.map(wi => `- ${wi.id}: ${wi.title}`).join("\n");
        effectiveSystemPrompt += `\n\n## Open Work Items\n\nBelow are currently open work items. If the message is about the same topic as an existing item, return that item's ID in workItemIds instead of leaving it empty. This prevents duplicate work items.\n\n${itemLines}`;
      }

      // Prepend sender context to message if provided
      let effectiveMessage = message;
      if (senderContext) {
        effectiveMessage = `[Sender: ${senderContext.senderName} (${senderContext.senderType}) | Channel: ${senderContext.channelName}]\n${message}`;
      }

      const result = await this.provider.classify(
        effectiveMessage,
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
        targetedAtOperator: this.computeTargetedAtOperator({ ...result, status }, effectiveIdentities),
        actionRequiredFrom: result.action_required_from ?? null,
        nextAction: result.next_action ?? null,
        breakdown: result.breakdown?.map((b) => {
          const bStatus = (VALID_STATUSES.has(b.status) ? b.status : "noise") as StatusCategory;
          return {
            workItemId: b.workItemId,
            status: bStatus,
            entryType: (b as { entry_type?: string }).entry_type as EntryType ?? inferEntryType(bStatus),
            confidence: Math.max(0, Math.min(1, b.confidence)),
            reason: b.reason,
            title: b.title,
            targetedAtOperator: this.computeTargetedAtOperator({ ...b, status: bStatus }, effectiveIdentities),
            actionRequiredFrom: b.action_required_from ?? null,
            nextAction: b.next_action ?? null,
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
        actionRequiredFrom: null,
        nextAction: null,
      };
    }
  }

  private computeTargetedAtOperator(
    result: { status?: string; action_required_from?: string[] | null; targeted_at_operator?: boolean },
    operatorIdentities?: OperatorIdentityMap | null,
  ): boolean {
    const isActionable = result.status === "blocked_on_human" || result.status === "needs_decision";

    if (result.action_required_from !== undefined) {
      // null = classifier says "no action needed".  But if the status IS
      // blocked_on_human or needs_decision, that's a contradiction — action IS
      // needed, the classifier just couldn't identify who.  Treat as unknown
      // actor → operator is backstop.
      if (result.action_required_from === null) {
        return isActionable; // true for blocks, false for FYI
      }
      // Empty array = action needed but actor unknown → operator is backstop
      if (result.action_required_from.length === 0) {
        return true;
      }
      // Has specific IDs — check against all operator platform identities
      if (operatorIdentities && operatorIdentities.size > 0) {
        const operatorIds = new Set([...operatorIdentities.values()].map((id) => id.userId));
        if (result.action_required_from.some((id) => operatorIds.has(id))) {
          return true; // operator is explicitly in the list
        }
        // Other people are named, operator is not — not targeted at operator
        return false;
      }
      // Has IDs but no operator identities available — default to true (safer)
      log.warn("action_required_from populated but no operator identities available — defaulting targetedAtOperator=true");
      return true;
    }
    // Field absent entirely — for actionable statuses, operator is backstop
    if (isActionable) return true;
    // For non-actionable, fall back to LLM's boolean, default true
    return result.targeted_at_operator !== false;
  }
}
