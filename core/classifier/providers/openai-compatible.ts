// core/classifier/providers/openai-compatible.ts — Universal provider for OpenAI-compatible and Anthropic APIs

import { createLogger } from "../../logger.js";
import type { ClassificationResult, ModelProvider } from "./interface.js";

const log = createLogger("openai-compatible");

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface BackoffState {
  active: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
}

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** Error with an optional Retry-After hint (seconds) from 429 responses */
class ApiError extends Error {
  retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.message.includes("timeout")) return true;
    if (error.message.includes("429")) return true;
    if (error.message.includes("502") || error.message.includes("503") || error.message.includes("504")) return true;
  }
  return false;
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function getBackoffMs(attempt: number): number {
  const base = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.3; // up to 30% jitter
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;

  // Backoff state — exposed so the server can surface it to the UI
  private _backoff: BackoffState = {
    active: false,
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  };

  get backoffState(): BackoffState {
    return { ...this._backoff };
  }

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
  }

  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const rawText = this.isAnthropic
          ? await this.callAnthropic(message, systemPrompt, fewShotExamples)
          : await this.callOpenAI(message, systemPrompt, fewShotExamples);

        // Success — clear backoff state
        if (this._backoff.active) {
          log.info("LLM recovered after backoff");
        }
        this._backoff = { active: false, retryCount: 0, nextRetryAt: null, lastError: null };

        const result = this.parseResponse(rawText);
        log.debug("Classification result", { input: message.slice(0, 120), result });
        return result;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_RETRIES && isRetryable(error)) {
          const serverDelay = error instanceof ApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1000
            : undefined;
          const delayMs = serverDelay ?? getBackoffMs(attempt);
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          const errorMsg = error instanceof Error ? error.message.slice(0, 200) : String(error);

          this._backoff = {
            active: true,
            retryCount: attempt + 1,
            nextRetryAt,
            lastError: errorMsg,
          };

          log.warn(
            `Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}), backing off ${Math.ceil(delayMs / 1000)}s`,
            errorMsg,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // Non-retryable or exhausted retries
        this._backoff = {
          active: false,
          retryCount: 0,
          nextRetryAt: null,
          lastError: error instanceof Error ? error.message.slice(0, 200) : String(error),
        };
        log.error("Classification failed", error);
        throw error;
      }
    }

    throw lastError;
  }

  private async callAnthropic(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const messages = [
      ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
      { role: "user" as const, content: message },
    ];

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    };

    log.debug("Calling Anthropic API", { url, model: this.model });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryAfter = parseRetryAfter(response);
      throw new ApiError(`Anthropic API error ${response.status}: ${text}`, retryAfter);
    }

    const json = (await response.json()) as {
      content: Array<{ text: string }>;
    };
    return json.content[0].text;
  }

  private async callOpenAI(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const makeMessages = (useSystemRole: boolean) => {
      if (useSystemRole) {
        return [
          { role: "system" as const, content: systemPrompt },
          ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
          { role: "user" as const, content: message },
        ];
      }
      // Fold system prompt into the first user message for models that don't support system role
      return [
        ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
        { role: "user" as const, content: `${systemPrompt}\n\n---\n\n${message}` },
      ];
    };

    const doCall = async (useSystemRole: boolean): Promise<string> => {
      const body = {
        model: this.model,
        messages: makeMessages(useSystemRole),
        temperature: 0,
      };

      log.debug("Calling OpenAI-compatible API", { url, model: this.model, useSystemRole });

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        // Some models don't support system/developer role — retry with prompt folded into user message
        if (response.status === 400 && text.includes("not enabled") && useSystemRole) {
          log.warn("Model does not support system role, retrying with prompt in user message");
          return doCall(false);
        }
        const retryAfter = parseRetryAfter(response);
        throw new ApiError(`OpenAI API error ${response.status}: ${text}`, retryAfter);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return json.choices[0].message.content;
    };

    return doCall(true);
  }

  private parseResponse(rawText: string): ClassificationResult {
    // Strip markdown code fences if present
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const status = typeof parsed.status === "string" ? parsed.status : "noise";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    const workItemIds = Array.isArray(parsed.workItemIds)
      ? (parsed.workItemIds.filter((id) => typeof id === "string") as string[])
      : [];

    const title = typeof parsed.title === "string" ? parsed.title : "";

    const targeted_at_operator = typeof parsed.targeted_at_operator === "boolean"
      ? parsed.targeted_at_operator
      : undefined;

    const action_required_from = Array.isArray(parsed.action_required_from)
      ? (parsed.action_required_from.filter((id) => typeof id === "string") as string[])
      : null;

    const next_action = typeof parsed.next_action === "string" ? parsed.next_action : null;

    // Parse per-work-item breakdown for summary messages
    let breakdown: ClassificationResult["breakdown"];
    if (Array.isArray(parsed.breakdown) && parsed.breakdown.length > 0) {
      breakdown = (parsed.breakdown as Record<string, unknown>[])
        .filter((b) => typeof b.workItemId === "string" && typeof b.status === "string")
        .map((b) => ({
          workItemId: b.workItemId as string,
          status: b.status as string,
          confidence: typeof b.confidence === "number" ? b.confidence : confidence,
          reason: typeof b.reason === "string" ? b.reason : "",
          title: typeof b.title === "string" ? b.title : "",
          targeted_at_operator: typeof b.targeted_at_operator === "boolean"
            ? b.targeted_at_operator
            : undefined,
          action_required_from: Array.isArray(b.action_required_from)
            ? (b.action_required_from as unknown[]).filter((id) => typeof id === "string") as string[]
            : null,
          next_action: typeof b.next_action === "string" ? b.next_action : null,
        }));
    }

    return { status, confidence, reason, workItemIds, title, targeted_at_operator, action_required_from, next_action, breakdown };
  }
}
