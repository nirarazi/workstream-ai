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
 * The model can't classify this message: its reply came back but wasn't a usable classification (`billed`), or
 * the provider rejected the request itself as invalid. Unlike an outage, trying the same message again won't help.
 */
export class InvalidReplyError extends Error {
  constructor(message: string, readonly billed: boolean) {
    super(message);
  }
}

export interface ModelProvider {
  name: string;
  classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult>;
}
