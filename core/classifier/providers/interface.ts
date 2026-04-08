// core/classifier/providers/interface.ts — ModelProvider interface for the status classifier

export interface BreakdownItem {
  workItemId: string;
  status: string;
  confidence: number;
  reason: string;
  title: string;
}

export interface ClassificationResult {
  status: string;
  confidence: number;
  reason: string;
  workItemIds: string[];
  title: string;
  breakdown?: BreakdownItem[];
}

export interface ModelProvider {
  name: string;
  classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult>;
}
