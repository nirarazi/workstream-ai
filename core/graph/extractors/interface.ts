// core/graph/extractors/interface.ts — Extractor interface for work item ID extraction

export interface Extractor {
  name: string;
  extractWorkItemIds(text: string): string[];
}
