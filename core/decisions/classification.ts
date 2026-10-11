// core/decisions/classification.ts — The classifier's closed-set decisions, expressed as DecisionProvider questions
//
// This covers the decisions that pick from a fixed set: status, whether the item belongs in the
// operator's inbox, and (optionally) which candidate work item a message continues. Free-text
// fields (title, next_action, reason) stay with the LLM classifier and are only needed for
// items that actually surface.

import type { StatusCategory } from "../types.js";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionProvider,
  DecisionUsage,
  QuestionSet,
  YesNoAnswer,
  YesNoQuestion,
} from "./interface.js";

export const NO_MATCH = "none";

export const STATUS_OPTIONS: Record<StatusCategory, string> = {
  completed:
    "The sender reports that a task is finished (done, merged, deployed, shipped). A mentioned follow-up task does not change this.",
  in_progress:
    "Work is underway: progress updates, partial completion, or a block on infrastructure the agent says it will retry or recover from by itself. Also reports about another agent's or person's state.",
  blocked_on_human:
    "A human has to do work before the sender can continue: a manual action (credentials, access, a call) or approving/reviewing a work product (a draft, a PR, a quote). The human holds responsibility until they respond, even if the reply is just \"approved\". Includes errors that come with a request for help.",
  needs_decision:
    "A human has to choose a direction, with no work product to inspect: the sender presents options or asks which way to go, and the work returns to the sender as soon as someone chooses.",
  noise:
    "Nothing to act on: greetings, acknowledgements, routine status without new information, or templated alerts from notification bots.",
};

export interface DecisionClassificationInput {
  message: string;
  senderName?: string;
  /** "agent" | "human" | "notification" */
  senderType?: string;
  channelName?: string;
  operatorName?: string;
  /** Free-text description of the operator's remit, from config.operator.context. */
  operatorContext?: string;
  candidateWorkItems?: Array<{ id: string; title: string }>;
}

export interface DecisionClassification {
  status: StatusCategory;
  /** Confidence of the status answer (distribution concentration). */
  confidence: number;
  statusProbabilities: Record<StatusCategory, number>;
  /** P(this item belongs in the operator's inbox). */
  targetedProbability: number;
  targetedAtOperator: boolean;
  /** Present only when candidates were supplied; null means "none of them". */
  workItemId?: string | null;
  workItemConfidence?: number;
  usage?: DecisionUsage;
  latencyMs: number;
}

export function buildState(input: DecisionClassificationInput): string {
  const header: string[] = [];
  if (input.senderName) header.push(`Sender: ${input.senderName}${input.senderType ? ` (${input.senderType})` : ""}`);
  if (input.channelName) header.push(`Channel: ${input.channelName}`);
  return [header.join(" | "), "Message:", input.message].filter(Boolean).join("\n");
}

export interface ClassificationQuestions {
  status: ChoiceQuestion;
  targeted: YesNoQuestion;
  workItem?: ChoiceQuestion;
}

export function buildClassificationQuestions(input: DecisionClassificationInput): ClassificationQuestions {
  const operator = input.operatorName ? `the operator (${input.operatorName})` : "the operator";
  const remit = input.operatorContext ? ` The operator's remit: ${input.operatorContext}` : "";

  const status: ChoiceQuestion = {
    type: "choice",
    instructions:
      "What is the current state of the work this message is about, from the sender's point of view? Choose blocked_on_human when the sender waits for something specific, and needs_decision when the sender presents options.",
    options: STATUS_OPTIONS,
  };

  const targeted: YesNoQuestion = {
    type: "yesno",
    instructions:
      `Should ${operator}, who supervises this fleet of AI agents, see this message in their inbox? Yes if they are addressed or mentioned, if an agent needs a human and nobody else named is handling it, or if it falls within their remit. No if it is purely informational or another named person is already handling it.${remit}`,
  };

  const candidates = input.candidateWorkItems ?? [];
  if (candidates.length === 0) return { status, targeted };

  const workItem: ChoiceQuestion = {
    type: "choice",
    instructions:
      "Which existing work item is this message about? Match on topic (same task, same error, a follow-up), not just the same sender. Choose none if no candidate fits.",
    options: {
      ...Object.fromEntries(candidates.slice(0, 254).map((c) => [c.id, c.title || c.id])),
      [NO_MATCH]: "None of these work items; a new or unrelated topic.",
    },
  };
  return { status, targeted, workItem };
}

export async function classifyWithDecisions(
  provider: DecisionProvider,
  input: DecisionClassificationInput,
  targetedThreshold = 0.5,
): Promise<DecisionClassification> {
  const { workItem, ...base } = buildClassificationQuestions(input);
  const questions: QuestionSet = workItem ? { ...base, workItem } : base;
  const result = await provider.decide(buildState(input), questions);
  const answers = result.answers as {
    status: ChoiceAnswer;
    targeted: YesNoAnswer;
    workItem?: ChoiceAnswer;
  };

  const status = answers.status.choice as StatusCategory;
  const out: DecisionClassification = {
    status,
    confidence: answers.status.confidence,
    statusProbabilities: answers.status.probabilities as Record<StatusCategory, number>,
    targetedProbability: answers.targeted.probability,
    // Mirror the LLM classifier's rule: the operator is the backstop for every block.
    targetedAtOperator:
      status === "blocked_on_human" || status === "needs_decision"
        ? true
        : answers.targeted.probability >= targetedThreshold,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
  if (answers.workItem) {
    out.workItemId = answers.workItem.choice === NO_MATCH ? null : answers.workItem.choice;
    out.workItemConfidence = answers.workItem.confidence;
  }
  return out;
}
