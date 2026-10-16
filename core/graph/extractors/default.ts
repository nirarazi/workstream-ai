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
// Teams whose real project key is on this list set taskAdapter.ticketPrefixes.
const NOT_TICKET_KEYS = new Set([
  "UTF", "SHA", "MD", "ISO", "RFC", "CVE", "CWE", "GPT", "AES", "RSA", "ECDSA", "TLS", "SSL", "HTTP", "IPV",
  "COVID", "WCAG", "ECMA", "IEEE", "ANSI", "ASCII", "BASE", "UUID", "OAUTH", "TOP", "PEP", "RC", "FP",
  "BF", "CRC", "WPA", "PKCS", "NIST",
]);

/** Whether `id` looks like a ticket key (KEY-123) and isn't a technical term such as UTF-8 or SHA-256 */
export function looksLikeTicketKey(id: string): boolean {
  const m = /^([A-Z][A-Z0-9]+)-\d+$/.exec(id.toUpperCase());
  return m !== null && !NOT_TICKET_KEYS.has(m[1]);
}

/**
 * Known ticket prefixes (e.g. ["OPS-", "ENG-"]): the configured ones plus those the task adapter
 * learned from the tracker (Jira's project keys), upper-cased and without duplicates.
 */
export function knownTicketPrefixes(
  configured: string[] | undefined,
  taskAdapter?: { getValidIdPrefixes?(): string[] } | null,
): string[] {
  const all = [...(configured ?? []), ...(taskAdapter?.getValidIdPrefixes?.() ?? [])];
  return [...new Set(all.map((p) => p.toUpperCase()))];
}

export interface DefaultExtractorConfig {
  ticketPatterns: string[];
  prPatterns: string[];
  /** Known ticket prefixes (e.g. ["OPS-", "ENG-", "MKT-"]), or a function returning the current ones */
  ticketPrefixes?: string[] | (() => string[]);
  /** IDs that are work items already, which are kept whatever their prefix */
  isKnownId?: (id: string) => boolean;
}

export class DefaultExtractor implements Extractor {
  readonly name = "default";
  private ticketRegexes: RegExp[];
  private prefixSource: () => string[];
  private isKnownId: (id: string) => boolean;

  constructor(config: DefaultExtractorConfig) {
    this.ticketRegexes = config.ticketPatterns.map((p) => new RegExp(p, "g"));
    const source = config.ticketPrefixes ?? [];
    this.prefixSource = typeof source === "function" ? source : () => source;
    this.isKnownId = config.isKnownId ?? (() => false);
  }

  private get ticketPrefixes(): string[] {
    return this.prefixSource().map((p) => p.toUpperCase());
  }

  extractWorkItemIds(text: string): string[] {
    const ids = new Set<string>();
    const prefixes = this.ticketPrefixes;

    for (const regex of this.ticketRegexes) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const captured = match[1] ?? match[0];
        // Only accept IDs whose prefix is in the known ticket prefixes list. With none configured, accept
        // anything shaped like a ticket key except common technical terms.
        const valid = prefixes.length === 0 ? looksLikeTicketKey(captured) : this.matchesKnownPrefix(captured, prefixes);
        if (valid || this.isKnownId(captured)) {
          ids.add(captured);
        }
      }
    }

    // PR patterns removed — the LLM classifier handles these via workItemIds,
    // which avoids false positives on "#N" in natural language.

    return Array.from(ids);
  }

  private matchesKnownPrefix(id: string, prefixes: string[]): boolean {
    const upper = id.toUpperCase();
    return prefixes.some((prefix) => upper.startsWith(prefix));
  }
}
