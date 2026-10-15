// core/classifier/providers/openai-compatible.ts — Universal provider for OpenAI-compatible and Anthropic APIs

import { createLogger } from "../../logger.js";
import { InvalidReplyError, ProviderAuthError, type ClassificationResult, type ClassifyOptions, type ModelProvider } from "./interface.js";

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
  /** Sent as reasoning_effort on OpenAI-compatible calls, e.g. "none" to turn off thinking in local models. */
  reasoningEffort?: string;
}

/** Error with an optional Retry-After hint (seconds) from 429 responses */
class ApiError extends Error {
  retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number, readonly status?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Statuses meaning the provider refused this request as sent, unlike auth, outages or rate limits */
const REQUEST_REJECTED = new Set([400, 413, 422]);
/** A refusal that's about this message (too long, flagged by moderation) rather than the account or settings */
const MESSAGE_REFUSAL = /context.?length|maximum context|too long|too many tokens|token limit|moderat|flagged/i;

/**
 * Map a provider refusal to what it means for retrying this message. Only a 401 is surely about the credentials;
 * a 403 can also be a gateway or firewall blocking this message's content, so it's handled per message (backoff,
 * newer messages first) rather than pausing everything.
 */
function classifyRefusal(err: ApiError): Error {
  if (err.status === 401) {
    return new ProviderAuthError("Model provider refused the API key (HTTP 401)");
  }
  if (err.status === 413) {
    return new InvalidReplyError("Model refused this message (HTTP 413)", false, true);
  }
  return new InvalidReplyError(`Model refused the request (HTTP ${err.status})`, false, MESSAGE_REFUSAL.test(err.message));
}

/**
 * A provider error for logs and the status shown in the UI. An API error's body can echo the request, including
 * the message being classified, so only its status is kept.
 */
export function describeProviderError(error: unknown): string {
  if (error instanceof ApiError) return `${error.status !== undefined ? `HTTP ${error.status}` : "API error"} from the model provider`;
  // A parse error's message quotes the reply, so only its name is kept
  if (error instanceof SyntaxError) return error.name;
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : String(error).slice(0, 200);
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  // Decide on the status, not the message: an API error's message includes a body that can echo anything
  if (error instanceof ApiError) return error.status !== undefined && RETRYABLE_STATUS.has(error.status);
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.message.includes("timeout")) return true;
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

function cachedText(text: string) {
  return { type: "text" as const, text, cache_control: { type: "ephemeral" as const } };
}

/** A completion's text plus the token usage the endpoint reported, when it reports any. */
export interface Completion {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;
  private readonly cacheBreakpoints: boolean;
  private readonly reasoningEffort?: string;
  private abortController = new AbortController();
  private disposed = false;

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

  /** Cancel all in-flight requests and retry delays */
  abort(): void {
    this.abortController.abort();
    if (!this.disposed) this.abortController = new AbortController();
    this._backoff = { active: false, retryCount: 0, nextRetryAt: null, lastError: null };
  }

  /**
   * Cancel everything and refuse every later call. For a provider replaced by new settings: a call still
   * waiting on the rate limiter must not reach the old endpoint with the old key once it gets its turn.
   */
  dispose(): void {
    this.disposed = true;
    this.abort();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Provider was replaced by new settings");
  }

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.model = config.model;
    this.reasoningEffort = config.reasoningEffort;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
    // Claude needs explicit cache breakpoints (directly or through OpenRouter); other providers cache
    // repeated prefixes on their own.
    this.cacheBreakpoints = this.isAnthropic || this.model.startsWith("anthropic/");
  }

  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    let rawText: string;
    try {
      rawText = (await this.completeWithUsage(message, systemPrompt, fewShotExamples, options)).text;
    } catch (err) {
      if (err instanceof ApiError && err.status !== undefined && (REQUEST_REJECTED.has(err.status) || err.status === 401 || err.status === 403)) {
        throw classifyRefusal(err);
      }
      throw err;
    }
    let result: ClassificationResult;
    try {
      result = this.parseResponse(rawText);
    } catch {
      // No reply text in the message: it can echo the classified message
      throw new InvalidReplyError("Model reply wasn't a usable classification", true, true);
    }
    log.debug("Classification result", { input: message.slice(0, 120), result });
    return result;
  }

  /** Raw completion with retry/backoff. Shared by the classifier and the LLM decision provider. */
  async complete(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }> = [],
  ): Promise<string> {
    return (await this.completeWithUsage(message, systemPrompt, fewShotExamples)).text;
  }

  /** Like complete(), plus the token usage the endpoint reported (if any). */
  async completeWithUsage(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }> = [],
    options?: ClassifyOptions,
  ): Promise<Completion> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const completion = this.isAnthropic
          ? await this.callAnthropic(message, systemPrompt, fewShotExamples)
          : await this.callOpenAI(message, systemPrompt, fewShotExamples);

        // Success — clear backoff state
        if (this._backoff.active) {
          log.info("LLM recovered after backoff");
        }
        this._backoff = { active: false, retryCount: 0, nextRetryAt: null, lastError: null };
        return completion;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.name === "TimeoutError") options?.onTimedOutAttempt?.();

        if (attempt < MAX_RETRIES && isRetryable(error)) {
          const serverDelay = error instanceof ApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1000
            : undefined;
          const delayMs = serverDelay ?? getBackoffMs(attempt);
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          const errorMsg = describeProviderError(error);

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
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            this.abortController.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("Provider aborted"));
            }, { once: true });
          });
          continue;
        }

        // Non-retryable or exhausted retries
        this._backoff = {
          active: false,
          retryCount: 0,
          nextRetryAt: null,
          lastError: describeProviderError(error),
        };
        log.error("LLM call failed", describeProviderError(error));
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Marks the end of the static prefix (system prompt + few-shot examples) as cacheable, so repeat calls
   * read it at the cache price. Per-message context lives in the final user turn, after the breakpoint.
   */
  private withCacheBreakpoint(
    messages: Array<{ role: string; content: string }>,
  ): Array<{ role: string; content: string | Array<ReturnType<typeof cachedText>> }> {
    if (!this.cacheBreakpoints || messages.length === 0) return messages;
    const last = messages[messages.length - 1];
    return [...messages.slice(0, -1), { role: last.role, content: [cachedText(last.content)] }];
  }

  private async callAnthropic(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<Completion> {
    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const messages = [
      ...this.withCacheBreakpoint(fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content }))),
      { role: "user" as const, content: message },
    ];

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: this.cacheBreakpoints && fewShotExamples.length === 0 ? [cachedText(systemPrompt)] : systemPrompt,
      messages,
    };

    log.debug("Calling Anthropic API", { url, model: this.model });

    this.assertActive();

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), this.abortController.signal]),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryAfter = parseRetryAfter(response);
      throw new ApiError(`Anthropic API error ${response.status}: ${text}`, retryAfter, response.status);
    }

    const json = (await response.json()) as {
      content: Array<{ text: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: json.content[0].text,
      usage: json.usage && { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 },
    };
  }

  private async callOpenAI(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<Completion> {
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
          ...this.withCacheBreakpoint([
            { role: "system", content: systemPrompt },
            ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
          ]),
          { role: "user" as const, content: message },
        ];
      }
      // Fold system prompt into the first user message for models that don't support system role
      return [
        ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
        { role: "user" as const, content: `${systemPrompt}\n\n---\n\n${message}` },
      ];
    };

    const doCall = async (useSystemRole: boolean): Promise<Completion> => {
      const body = {
        model: this.model,
        messages: makeMessages(useSystemRole),
        temperature: 0,
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      };

      log.debug("Calling OpenAI-compatible API", { url, model: this.model, useSystemRole });

      this.assertActive();

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(30_000), this.abortController.signal]),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        // Some models don't support system/developer role — retry with prompt folded into user message
        if (response.status === 400 && text.includes("not enabled") && useSystemRole) {
          log.warn("Model does not support system role, retrying with prompt in user message");
          return doCall(false);
        }
        const retryAfter = parseRetryAfter(response);
        throw new ApiError(`OpenAI API error ${response.status}: ${text}`, retryAfter, response.status);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: json.choices[0].message.content,
        usage: json.usage && { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 },
      };
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Reply is not a JSON object");
    }

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
