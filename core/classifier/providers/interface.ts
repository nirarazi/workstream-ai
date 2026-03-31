// core/classifier/providers/interface.ts — ModelProvider interface for the status classifier

export interface ClassificationResult {
  status: string;
  confidence: number;
  reason: string;
  workItemIds: string[];
}

export interface ModelProvider {
  name: string;
  classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult>;
}
