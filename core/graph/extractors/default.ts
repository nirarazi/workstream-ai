// core/graph/extractors/default.ts — Regex-based work item ID extractor
//
// Only extracts IDs that match known ticket prefixes (e.g. AI-, IT-, MS-).
// This avoids false positives like "Gateway restart #2" → "PR-2".
// Ambiguous references (PR #N, bare #N) are left to the LLM classifier's
// workItemIds field, which understands context.

import type { Extractor } from "./interface.js";

export interface DefaultExtractorConfig {
  ticketPatterns: string[];
  prPatterns: string[];
  /** Known ticket prefixes from config (e.g. ["AI-", "IT-", "MS-"]) */
  ticketPrefixes?: string[];
}

export class DefaultExtractor implements Extractor {
  readonly name = "default";
  private ticketRegexes: RegExp[];
  private ticketPrefixes: string[];

  constructor(config: DefaultExtractorConfig) {
    this.ticketRegexes = config.ticketPatterns.map((p) => new RegExp(p, "g"));
    this.ticketPrefixes = (config.ticketPrefixes ?? []).map((p) => p.toUpperCase());
  }

  extractWorkItemIds(text: string): string[] {
    const ids = new Set<string>();

    for (const regex of this.ticketRegexes) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const captured = match[1] ?? match[0];
        // Only accept IDs whose prefix is in the known ticket prefixes list.
        // If no prefixes are configured, accept all matches (backwards compat).
        if (this.ticketPrefixes.length === 0 || this.matchesKnownPrefix(captured)) {
          ids.add(captured);
        }
      }
    }

    // PR patterns removed — the LLM classifier handles these via workItemIds,
    // which avoids false positives on "#N" in natural language.

    return Array.from(ids);
  }

  private matchesKnownPrefix(id: string): boolean {
    const upper = id.toUpperCase();
    return this.ticketPrefixes.some((prefix) => upper.startsWith(prefix));
  }
}
