// core/graph/extractors/default.ts — Regex-based work item ID extractor
//
// Extracts IDs that match the configured ticket prefixes (e.g. OPS-, ENG-, MKT-). With none configured, it
// accepts any KEY-123 key except technical terms such as UTF-8 or SHA-256.
// This avoids false positives like "Gateway restart #2" → "PR-2".
// Ambiguous references (PR #N, bare #N) are left to the LLM classifier's
// workItemIds field, which understands context.

import type { Extractor } from "./interface.js";

// Technical terms shaped like ticket keys. With no ticket prefixes configured, these would otherwise
// become work items and group unrelated threads under, say, "UTF-8".
const NOT_TICKET_KEYS = new Set([
  "UTF", "SHA", "MD", "ISO", "RFC", "CVE", "CWE", "GPT", "AES", "RSA", "ECDSA", "TLS", "SSL", "HTTP", "IPV",
  "COVID", "WCAG", "PCI", "SOC", "ES", "ECMA", "IEEE", "ANSI", "ASCII", "BASE", "UUID", "OAUTH", "TOP",
]);

/** Whether `id` looks like a ticket key (KEY-123) and isn't a technical term such as UTF-8 or SHA-256 */
export function looksLikeTicketKey(id: string): boolean {
  const m = /^([A-Z][A-Z0-9]*)-\d+$/.exec(id.toUpperCase());
  return m !== null && !NOT_TICKET_KEYS.has(m[1]);
}

export interface DefaultExtractorConfig {
  ticketPatterns: string[];
  prPatterns: string[];
  /** Known ticket prefixes from config (e.g. ["OPS-", "ENG-", "MKT-"]) */
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
        // Only accept IDs whose prefix is in the known ticket prefixes list. With none configured, accept
        // anything shaped like a ticket key except common technical terms.
        if (this.ticketPrefixes.length === 0 ? looksLikeTicketKey(captured) : this.matchesKnownPrefix(captured)) {
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
