// core/classifier/index.ts — Classifier orchestrator

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logger.js";
import { findProjectRoot, type Config } from "../config.js";
import type { Classification, EntryType, OperatorIdentityMap, StatusCategory, ThreadContext } from "../types.js";
import { applyDecision, createDecisionGate, type DecisionGate } from "../decisions/gate.js";
import { OpenAICompatibleProvider, type BackoffState } from "./providers/openai-compatible.js";
import { InvalidReplyError, type ModelProvider } from "./providers/interface.js";
import type { RateLimiter } from "../rate-limiter.js";
import { BudgetExhaustedError } from "../usage/tracker.js";

const log = createLogger("classifier");

function timeAgoShort(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

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

/** The remit (operator.context) is what lets the model decide targeting instead of the backstop rule. */
export function hasRemit(config: Config): boolean {
  return Boolean(config.operator?.context?.trim());
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

const THREAD_CONTEXT_CHARS = 300;

export function formatThreadContext(ctx: ThreadContext): string {
  const lines = ["## This Thread", ""];
  if (ctx.workItem) {
    const status = ctx.workItem.status ? ` (${ctx.workItem.status})` : "";
    // Inferred work items are keyed "thread:<ts>"; that id means nothing to the model.
    const id = ctx.workItem.id.startsWith("thread:") ? "" : `${ctx.workItem.id}: `;
    lines.push(`The new message belongs to a thread about ${id}"${ctx.workItem.title}"${status}.`);
  }
  if (ctx.messages.length > 0) {
    lines.push("Earlier messages in the thread, oldest first:");
    for (const m of ctx.messages) {
      const text = m.text.replace(/\s+/g, " ").trim();
      lines.push(`- [${m.senderName}] "${text.length > THREAD_CONTEXT_CHARS ? text.slice(0, THREAD_CONTEXT_CHARS) + "…" : text}"`);
    }
  }
  lines.push("", "Use this to understand what the new message refers to (\"approved\", \"go ahead\", \"same error\"), but classify only the new message.");
  return lines.join("\n");
}

export function createProvider(config: Config): ModelProvider {
  const { baseUrl, model, apiKey, reasoningEffort } = config.classifier.provider;
  const isAnthropic = baseUrl.includes("anthropic");
  const name = isAnthropic ? "anthropic" : "openai-compatible";
  return new OpenAICompatibleProvider({ name, baseUrl, model, apiKey, reasoningEffort });
}

export class Classifier {
  private readonly provider: ModelProvider;
  private readonly systemPrompt: string;
  private readonly fewShotMessages: Array<{ role: string; content: string }>;
  private readonly operatorRole: string;
  private readonly operatorIdentities: OperatorIdentityMap | null;
  private readonly operatorContext: string;
  /** Whether the operator wrote a remit; a name alone doesn't say who owns what */
  private readonly hasRemit: boolean;
  private decisionGate: DecisionGate | null = null;
  private rateLimiter?: RateLimiter;

  constructor(
    provider: ModelProvider,
    systemPrompt: string,
    fewShotMessages: Array<{ role: string; content: string }>,
    rateLimiter?: RateLimiter,
    operatorRole?: string,
    operatorIdentities?: OperatorIdentityMap | null,
    operatorContext?: string,
    hasRemit?: boolean,
  ) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.fewShotMessages = fewShotMessages;
    this.rateLimiter = rateLimiter;
    this.operatorRole = operatorRole ?? "";
    this.operatorIdentities = operatorIdentities ?? null;
    this.operatorContext = operatorContext ?? "";
    this.hasRemit = hasRemit ?? Boolean(operatorContext);
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
    const classifier = new Classifier(provider, prompt.system, fewShot, undefined, operatorRole, null, operatorContext, hasRemit(config));
    classifier.setDecisionGate(createDecisionGate(config));
    return classifier;
  }

  /** Optional decision model that overrides status and inbox membership (classifier.mode: "decisions"). */
  setDecisionGate(gate: DecisionGate | null): void {
    this.decisionGate = gate;
  }

  async classify(
    message: string,
    candidateWorkItems?: Array<{ id: string; title: string; reasons?: string[] }>,
    operatorIdentities?: OperatorIdentityMap | null,
    senderContext?: { senderName: string; senderType: string; channelName: string },
    validIdPrefixes?: string[],
    channelContext?: Array<{
      workItemId: string;
      workItemTitle: string;
      senderName: string;
      text: string;
      timestamp: string;
    }>,
    threadContext?: ThreadContext,
  ): Promise<Classification> {
    const llm = this.classifyWithLLM(message, candidateWorkItems, operatorIdentities, senderContext, validIdPrefixes, channelContext, threadContext);
    if (!this.decisionGate) return llm;

    const identities = operatorIdentities ?? this.operatorIdentities;
    const decision = this.decisionGate.decide({
      message,
      senderName: senderContext?.senderName,
      senderType: senderContext?.senderType,
      channelName: senderContext?.channelName,
      operatorName: identities && identities.size > 0 ? [...identities.values()][0].userName : undefined,
      operatorContext: this.hasRemit ? this.operatorContext : undefined,
      threadContext,
    });
    const [llmResult, decisionResult] = await Promise.allSettled([llm, decision]);
    // classifyWithLLM never rejects (it falls back to noise internally)
    const base = (llmResult as PromiseFulfilledResult<Classification>).value;
    // Without the LLM's answer there's no title or links; the whole message is tried again later
    if (base.failed) return base;
    if (decisionResult.status === "rejected") {
      log.warn("Decision gate failed — using the LLM classification", decisionResult.reason);
      return base;
    }
    return applyDecision(base, decisionResult.value, senderContext?.senderType);
  }

  private async classifyWithLLM(
    message: string,
    candidateWorkItems?: Array<{ id: string; title: string; reasons?: string[] }>,
    operatorIdentities?: OperatorIdentityMap | null,
    senderContext?: { senderName: string; senderType: string; channelName: string },
    validIdPrefixes?: string[],
    channelContext?: Array<{
      workItemId: string;
      workItemTitle: string;
      senderName: string;
      text: string;
      timestamp: string;
    }>,
    threadContext?: ThreadContext,
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
- The issue is within the operator's stated remit, including any "escalate to me anyway" cases
- An agent is blocked and needs human intervention, and nobody else's remit covers it (the operator is the fleet's backstop)

Return false if:
- The block is on an external party (client, vendor) with no operator action possible
- Another human is handling it and hasn't escalated
- It's a status report about someone else's block with no request to intervene`;

        effectiveSystemPrompt += profileBlock;
      } else if (this.operatorContext) {
        effectiveSystemPrompt += `\n\n## Operator Context\n\n${this.operatorContext}`;
      }

      if (validIdPrefixes && validIdPrefixes.length > 0) {
        effectiveSystemPrompt += `\n\n## Valid Work Item ID Prefixes\n\nThe following prefixes are the ONLY valid work item ID patterns: ${validIdPrefixes.join(", ")}. Only return IDs in workItemIds that match one of these prefixes, or the exact ID of a candidate work item listed below (including "thread:…" IDs, which track items that have no ticket). IDs like "Q-123" or "CRM-456" that don't match a known prefix should NOT be included in workItemIds — they are external reference numbers, not tracked work items.`;
      }

      // Per-message context goes in the user turn, after the few-shot examples, so the system prompt and
      // examples form an identical prefix on every call — that prefix is what providers cache.
      const context: string[] = [];

      if (candidateWorkItems && candidateWorkItems.length > 0) {
        const itemLines = candidateWorkItems.map((wi, i) => {
          const reasons = wi.reasons?.length ? ` — ${wi.reasons.join(", ")}` : "";
          return `${i + 1}. ${wi.id}: "${wi.title}"${reasons}`;
        }).join("\n");
        context.push(`## Candidate Work Items (ranked by relevance)\n\nThe following work items are the most likely matches for this message, based on graph signals (same agent, same channel, recency, keyword overlap). If the message is about one of these items, return its ID in workItemIds. If none match, return an empty workItemIds array — do NOT force a match.\n\n${itemLines}`);
      }

      if (channelContext && channelContext.length > 0) {
        const contextLines = channelContext.map((ctx) => {
          const ago = timeAgoShort(ctx.timestamp);
          return `- [${ctx.senderName}, ${ago}] "${ctx.text}" → work item: ${ctx.workItemId}`;
        }).join("\n");
        context.push(`## Recent Messages from the Same Channel\n\nThe following recent messages are from the same channel as this new message. If this new message is a continuation of one of these conversations (a reply, follow-up, or related remark), return that conversation's work item ID in workItemIds. If it's a new, unrelated topic, return empty workItemIds as usual.\n\n${contextLines}`);
      }

      if (threadContext && (threadContext.workItem || threadContext.messages.length > 0)) {
        context.push(formatThreadContext(threadContext));
      }

      // Prepend sender context to message if provided
      let effectiveMessage = message;
      if (senderContext) {
        effectiveMessage = `[Sender: ${senderContext.senderName} (${senderContext.senderType}) | Channel: ${senderContext.channelName}]\n${message}`;
      }
      if (context.length > 0) {
        effectiveMessage = `${context.join("\n\n")}\n\n## New Message to Classify\n\n${effectiveMessage}`;
      }

      const result = await this.provider.classify(
        effectiveMessage,
        effectiveSystemPrompt,
        this.fewShotMessages,
      );

      if (!result) {
        log.warn("Provider returned empty result — defaulting to noise");
        return {
          status: "noise", entryType: "noise", confidence: 0.1,
          reason: "Provider returned empty result", workItemIds: [], title: "",
          targetedAtOperator: true, actionRequiredFrom: null, nextAction: null, failed: "invalid",
        };
      }

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
      const budget = error instanceof BudgetExhaustedError;
      if (!budget) log.warn("Classification failed, returning default noise classification", error);
      return {
        status: "noise",
        entryType: "noise",
        confidence: 0.1,
        reason: budget ? error.message : "Classification failed — defaulting to noise",
        workItemIds: [],
        title: "",
        targetedAtOperator: true,
        actionRequiredFrom: null,
        nextAction: null,
        failed: budget ? "budget" : error instanceof InvalidReplyError ? "invalid" : "unreachable",
      };
    }
  }

  private computeTargetedAtOperator(
    result: { status?: string; action_required_from?: string[] | null; targeted_at_operator?: boolean },
    operatorIdentities?: OperatorIdentityMap | null,
  ): boolean {
    const isActionable = result.status === "blocked_on_human" || result.status === "needs_decision";

    // With a remit, the model has been told who owns what, so its targeted_at_operator answer decides
    // instead of the backstop rule. Being named in action_required_from still always counts.
    if (this.hasRemit) {
      const operatorIds = new Set([...(operatorIdentities?.values() ?? [])].map((id) => id.userId));
      if (result.action_required_from?.some((id) => operatorIds.has(id))) return true;
      return result.targeted_at_operator ?? isActionable;
    }

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
