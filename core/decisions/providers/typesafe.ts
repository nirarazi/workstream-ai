// core/decisions/providers/typesafe.ts — TypeSafe Jev ("System One") decision provider
//
// Hosted-only, optional backend. API: POST {baseUrl}/v1/systemone
//   { model, state, questions: { key: { type: "choice"|"score"|"noul", instructions, criteria } } }
//   → { model, answers: { key: {...} }, usage: { input_tokens, output_tokens } }
// Schema per docs.typesafe.ai/api.md (checked 2026-10-10). Score levels are 0-based.

import { createLogger } from "../../logger.js";
import {
  concentration,
  normalize,
  validateQuestions,
  type Answers,
  type DecisionProvider,
  type DecisionResult,
  type Question,
  type QuestionSet,
} from "../interface.js";

const log = createLogger("decisions:typesafe");

const MAX_RETRIES = 4;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export interface TypeSafeConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

type WireAnswer =
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> }
  | { type: "noul"; noul: number };

interface WireResponse {
  model?: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function toWireQuestion(q: Question): WireQuestion {
  switch (q.type) {
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.options };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.levels };
    case "yesno":
      return { type: "noul", instructions: q.instructions };
  }
}

export function fromWireAnswers<Qs extends QuestionSet>(questions: Qs, wire: Record<string, WireAnswer>): Answers<Qs> {
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = wire[key];
    if (!a) throw new Error(`TypeSafe response missing answer for "${key}"`);

    if (q.type === "choice") {
      if (a.type !== "choice") throw new Error(`"${key}": expected choice answer, got ${a.type}`);
      const optionKeys = Object.keys(q.options);
      const probs = normalize(optionKeys.map((k) => a.probabilities?.[k] ?? (k === a.choice ? 1 : 0)));
      out[key] = {
        type: "choice",
        choice: a.choice,
        confidence: a.confidence ?? concentration(probs),
        probabilities: Object.fromEntries(optionKeys.map((k, i) => [k, probs[i]])),
      };
    } else if (q.type === "score") {
      if (a.type !== "score") throw new Error(`"${key}": expected score answer, got ${a.type}`);
      const probs = a.probabilities
        ? normalize(q.levels.map((_, i) => a.probabilities?.[String(i)] ?? 0))
        : q.levels.map((_, i) => (Math.round(a.score) === i ? 1 : 0));
      out[key] = {
        type: "score",
        score: a.score,
        confidence: a.confidence ?? concentration(probs),
        probabilities: probs,
      };
    } else {
      if (a.type !== "noul") throw new Error(`"${key}": expected noul answer, got ${a.type}`);
      out[key] = { type: "yesno", probability: Math.max(0, Math.min(1, a.noul)) };
    }
  }
  return out as Answers<Qs>;
}

export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly name = "typesafe";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TypeSafeConfig) {
    if (!config.apiKey) throw new Error("TypeSafe provider requires an apiKey");
    this.apiKey = config.apiKey;
    this.model = config.model ?? "jev-latest";
    this.baseUrl = (config.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async decide<Qs extends QuestionSet>(state: string, questions: Qs): Promise<DecisionResult<Qs>> {
    validateQuestions(questions);
    const body = JSON.stringify({
      model: this.model,
      state,
      questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, toWireQuestion(q)])),
    });

    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const json = (await response.json()) as WireResponse;
        return {
          answers: fromWireAnswers(questions, json.answers ?? {}),
          usage: {
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
          },
          latencyMs: Date.now() - started,
          model: json.model ?? this.model,
        };
      }

      const text = await response.text().catch(() => "");
      if (attempt < MAX_RETRIES && RETRYABLE.has(response.status)) {
        const delayMs = Math.min(1000 * 2 ** attempt, 15_000);
        log.warn(`TypeSafe ${response.status}, retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new Error(`TypeSafe API error ${response.status}: ${text.slice(0, 300)}`);
    }
  }
}
