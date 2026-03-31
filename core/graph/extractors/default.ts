// core/graph/extractors/default.ts — Regex-based work item ID extractor

import type { Extractor } from "./interface.js";

export interface DefaultExtractorConfig {
  ticketPatterns: string[];
  prPatterns: string[];
}

export class DefaultExtractor implements Extractor {
  readonly name = "default";
  private ticketRegexes: RegExp[];
  private prRegexes: RegExp[];

  constructor(config: DefaultExtractorConfig) {
    this.ticketRegexes = config.ticketPatterns.map((p) => new RegExp(p, "g"));
    this.prRegexes = config.prPatterns.map((p) => new RegExp(p, "g"));
  }

  extractWorkItemIds(text: string): string[] {
    const ids = new Set<string>();

    for (const regex of this.ticketRegexes) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const captured = match[1] ?? match[0];
        ids.add(captured);
      }
    }

    for (const regex of this.prRegexes) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const captured = match[1] ?? match[0];
        ids.add(`PR-${captured}`);
      }
    }

    return Array.from(ids);
  }
}
