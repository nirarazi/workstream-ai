// core/continuation/interface.ts — Extensibility types for continuation detection strategies

import type { Message } from "../types.js";

/**
 * A recent message from the same channel, used as context for continuation detection.
 */
export interface RecentChannelMessage {
  workItemId: string;
  workItemTitle: string;
  senderName: string;
  text: string;
  timestamp: string;
}

/**
 * Result of a continuation check — indicates the message should be linked
 * to an existing work item rather than creating a new one.
 */
export interface ContinuationResult {
  workItemId: string;
  confidence: number;
  refinedTitle?: string;
}

/**
 * Pluggable strategy for detecting conversation continuations.
 *
 * Implementations:
 * - ClassifierInline (shipped): enriches the classifier prompt with channel context.
 *   Returns null — the continuation decision is made by the classifier itself.
 * - PreClassifier (future): separate lightweight LLM call before classification.
 * - HeuristicPrefilter (future): deterministic checks before classifier enrichment.
 */
export interface ContinuationStrategy {
  name: string;
  findContinuation(params: {
    message: Message;
    channelId: string;
    recentMessages: RecentChannelMessage[];
  }): Promise<ContinuationResult | null>;
}
