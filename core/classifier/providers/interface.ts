// core/classifier/providers/interface.ts — ModelProvider interface for the status classifier

export interface BreakdownItem {
  workItemId: string;
  status: string;
  confidence: number;
  reason: string;
  title: string;
  targeted_at_operator?: boolean;
  action_required_from?: string[] | null;
  next_action?: string | null;
}

export interface ClassificationResult {
  status: string;
  confidence: number;
  reason: string;
  workItemIds: string[];
  title: string;
  targeted_at_operator?: boolean;
  /** Platform user IDs of who needs to take the next action. Null = FYI / no action needed. */
  action_required_from?: string[] | null;
  /** Short free-text description of what the action taker needs to do. Null when no action needed. */
  next_action?: string | null;
  breakdown?: BreakdownItem[];
}

/**
 * The model didn't produce a usable classification even though the provider was reached: its reply came back
 * but couldn't be used (`billed`), or the provider refused the request. `messageSpecific` says whether this
 * message is the cause (an unusable reply, a message too long, a moderation refusal), so retrying it won't help,
 * or the request was refused for a reason that affects every message (credit balance, an unsupported setting).
 */
export class InvalidReplyError extends Error {
  constructor(message: string, readonly billed: boolean, readonly messageSpecific: boolean) {
    super(message);
  }
}

/** The provider rejected the API key or account (401/403): nothing will classify until settings change. */
export class ProviderAuthError extends Error {}

export interface ModelProvider {
  name: string;
  classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult>;
}
