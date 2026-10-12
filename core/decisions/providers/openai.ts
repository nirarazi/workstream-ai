// core/decisions/providers/openai.ts — OpenAI Decisions API provider (gpt-6-luna)
//
// Hosted-only, optional backend, public beta since 2026-10-06. POST api.openai.com/v1/decisions:
//   { model, input, questions: [{ type: "choice"|"score"|"predicate", name, instructions, choices|levels }] }
//   → { model, answers: [{ type, name, ... }], usage: { input_tokens, output_tokens } }
// Schema per developers.openai.com/api/docs/guides/decisions (checked 2026-10-12). Score levels are 0-based.
// Billed on input tokens only.

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

const log = createLogger("decisions:openai");

const MAX_RETRIES = 4;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface OpenAIDecisionConfig {
  apiKey: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type WireQuestion =
  | { type: "choice"; name: string; instructions: string; choices: Array<{ value: string; description: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description: string }> }
  | { type: "predicate"; name: string; instructions: string };

type WireAnswer =
  | { type: "choice"; name: string; choice: string; confidence?: number; probabilities?: Array<{ value: string; probability: number }> }
  | { type: "score"; name: string; score: number; confidence?: number; probabilities?: Array<{ value: number; probability: number }> }
  | { type: "predicate"; name: string; probability: number }
  | { type: "refusal"; name: string; refusal?: string };

interface WireResponse {
  model?: string;
  answers?: WireAnswer[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function toOpenAIQuestion(name: string, q: Question): WireQuestion {
  switch (q.type) {
    case "choice":
      return {
        type: "choice",
        name,
        instructions: q.instructions,
        choices: Object.entries(q.options).map(([value, description]) => ({ value, description })),
      };
    case "score":
      // Our levels are plain labels; the label doubles as the description.
      return { type: "score", name, instructions: q.instructions, levels: q.levels.map((label) => ({ label, description: label })) };
    case "yesno":
      return { type: "predicate", name, instructions: q.instructions };
  }
}

export function fromOpenAIAnswers<Qs extends QuestionSet>(questions: Qs, wire: WireAnswer[]): Answers<Qs> {
  const byName = new Map(wire.map((a) => [a.name, a]));
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = byName.get(key);
    if (!a) throw new Error(`OpenAI decisions response missing answer for "${key}"`);
    if (a.type === "refusal") throw new Error(`OpenAI decisions refused "${key}": ${a.refusal ?? ""}`);

    if (q.type === "choice") {
      if (a.type !== "choice") throw new Error(`"${key}": expected choice answer, got ${a.type}`);
      const optionKeys = Object.keys(q.options);
      const given = new Map((a.probabilities ?? []).map((p) => [p.value, p.probability]));
      const probs = normalize(optionKeys.map((k) => given.get(k) ?? (k === a.choice ? 1 : 0)));
      out[key] = {
        type: "choice",
        choice: a.choice,
        confidence: a.confidence ?? concentration(probs),
        probabilities: Object.fromEntries(optionKeys.map((k, i) => [k, probs[i]])),
      };
    } else if (q.type === "score") {
      if (a.type !== "score") throw new Error(`"${key}": expected score answer, got ${a.type}`);
      const given = new Map((a.probabilities ?? []).map((p) => [p.value, p.probability]));
      const probs = a.probabilities
        ? normalize(q.levels.map((_, i) => given.get(i) ?? 0))
        : q.levels.map((_, i) => (Math.round(a.score) === i ? 1 : 0));
      out[key] = { type: "score", score: a.score, confidence: a.confidence ?? concentration(probs), probabilities: probs };
    } else {
      if (a.type !== "predicate") throw new Error(`"${key}": expected predicate answer, got ${a.type}`);
      out[key] = { type: "yesno", probability: Math.max(0, Math.min(1, a.probability)) };
    }
  }
  return out as Answers<Qs>;
}

export class OpenAIDecisionProvider implements DecisionProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIDecisionConfig) {
    if (!config.apiKey) throw new Error("OpenAI decision provider requires an apiKey");
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-6-luna";
    this.url = config.url ?? "https://api.openai.com/v1/decisions";
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async decide<Qs extends QuestionSet>(state: string, questions: Qs): Promise<DecisionResult<Qs>> {
    validateQuestions(questions);
    const body = JSON.stringify({
      model: this.model,
      input: state,
      questions: Object.entries(questions).map(([name, q]) => toOpenAIQuestion(name, q)),
    });

    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const json = (await response.json()) as WireResponse;
        return {
          answers: fromOpenAIAnswers(questions, json.answers ?? []),
          usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
          latencyMs: Date.now() - started,
          model: json.model ?? this.model,
        };
      }

      const text = await response.text().catch(() => "");
      if (attempt < MAX_RETRIES && RETRYABLE.has(response.status)) {
        const delayMs = Math.min(1000 * 2 ** attempt, 15_000);
        log.warn(`OpenAI decisions ${response.status}, retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new Error(`OpenAI decisions API error ${response.status}: ${text.slice(0, 300)}`);
    }
  }
}
