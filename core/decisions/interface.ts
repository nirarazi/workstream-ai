// core/decisions/interface.ts — DecisionProvider: bounded, typed decisions over a piece of state
//
// The classifier's job is mostly picking from closed sets (status, who it's for,
// which work item). A DecisionProvider answers a batch of typed questions about one
// "state" (the message plus context) and returns probabilities rather than prose.
//
// Implementations:
//   - LLMDecisionProvider  — any OpenAI-compatible/Anthropic endpoint, incl. Ollama (local default)
//   - TypeSafeDecisionProvider — TypeSafe's Jev "System One" model (hosted, optional)
//
// Questions are evaluated independently. Keep each one atomic and combine answers in code.

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** Option key → description. 1–255 options. */
  options: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Level descriptions, lowest first. 2–10 levels; level N is index N. */
  levels: string[];
};

export type YesNoQuestion = {
  type: "yesno";
  instructions: string;
};

export type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;
export type QuestionSet = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** 0–1. How concentrated the distribution is — not a correctness guarantee. */
  confidence: number;
  /** Option key → probability, sums to ~1. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index in [0, levels.length - 1]; may fall between levels. */
  score: number;
  confidence: number;
  /** probabilities[i] = P(level i). */
  probabilities: number[];
}

export interface YesNoAnswer {
  type: "yesno";
  /** P(yes), 0–1. */
  probability: number;
}

export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion ? ChoiceAnswer :
  Q extends ScoreQuestion ? ScoreAnswer :
  YesNoAnswer;

export type Answers<Qs extends QuestionSet> = { [K in keyof Qs]: AnswerFor<Qs[K]> };

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult<Qs extends QuestionSet> {
  answers: Answers<Qs>;
  usage?: DecisionUsage;
  latencyMs: number;
  model: string;
}

export interface DecisionProvider {
  readonly name: string;
  /**
   * Answer every question about `state`. `state` is untrusted data (agent messages):
   * implementations must keep it separate from the questions so it cannot rewrite them.
   */
  decide<Qs extends QuestionSet>(state: string, questions: Qs): Promise<DecisionResult<Qs>>;
}

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/** Throws on question sets no provider can answer, so both backends reject the same inputs. */
export function validateQuestions(questions: QuestionSet): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new Error("At least one question is required");
  for (const [key, q] of entries) {
    if (q.type === "choice") {
      const n = Object.keys(q.options).length;
      if (n < 1 || n > MAX_CHOICE_OPTIONS) {
        throw new Error(`Question "${key}": choice needs 1–${MAX_CHOICE_OPTIONS} options, got ${n}`);
      }
    } else if (q.type === "score") {
      const n = q.levels.length;
      if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) {
        throw new Error(`Question "${key}": score needs ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} levels, got ${n}`);
      }
    }
  }
}

/** 1 − normalized entropy: 1 when all mass is on one outcome, 0 when uniform. */
export function concentration(probabilities: number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  let h = 0;
  for (const p of probabilities) if (p > 0) h -= p * Math.log(p);
  return Math.max(0, Math.min(1, 1 - h / Math.log(n)));
}

/** Clamp negatives to 0 and rescale to sum to 1; uniform if everything is 0. */
export function normalize(values: number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum === 0) return clean.map(() => 1 / clean.length);
  return clean.map((v) => v / sum);
}
