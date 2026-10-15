// tests/graph/extractor.test.ts — Regex extractor edge cases

import { describe, it, expect } from "vitest";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

const defaultConfig = {
  ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
  prPatterns: ["PR\\s*#?(\\d+)", "#(\\d+)"],
  ticketPrefixes: ["OPS-", "ENG-", "MKT-"],
};

describe("DefaultExtractor", () => {
  const extractor = new DefaultExtractor(defaultConfig);

  describe("ticket extraction", () => {
    it("extracts tickets matching known prefixes", () => {
      const ids = extractor.extractWorkItemIds("Working on OPS-382 now");
      expect(ids).toContain("OPS-382");
    });

    it("extracts multiple tickets", () => {
      const ids = extractor.extractWorkItemIds("Linked OPS-382 to ENG-100 and MKT-112");
      expect(ids).toContain("OPS-382");
      expect(ids).toContain("ENG-100");
      expect(ids).toContain("MKT-112");
    });

    it("rejects tickets with unknown prefixes", () => {
      const ids = extractor.extractWorkItemIds("See DEPLOY-123 and UI-5");
      expect(ids).toHaveLength(0);
    });

    it("ignores lowercase prefixes", () => {
      const ids = extractor.extractWorkItemIds("working on ops-382");
      expect(ids).toHaveLength(0);
    });

    it("deduplicates repeated ticket IDs", () => {
      const ids = extractor.extractWorkItemIds("OPS-1 is related to OPS-1");
      expect(ids).toEqual(["OPS-1"]);
    });

    it("handles tickets at start and end of text", () => {
      const ids = extractor.extractWorkItemIds("OPS-100 done");
      expect(ids).toContain("OPS-100");

      const ids2 = extractor.extractWorkItemIds("done OPS-100");
      expect(ids2).toContain("OPS-100");
    });

    it("returns empty for text with no tickets", () => {
      const ids = extractor.extractWorkItemIds("Just a regular message with no references");
      expect(ids).toHaveLength(0);
    });
  });

  describe("PR patterns no longer extracted by regex", () => {
    it("does not extract PR #NNN — left to LLM classifier", () => {
      const ids = extractor.extractWorkItemIds("Review PR #716");
      expect(ids).toHaveLength(0);
    });

    it("does not extract #NNN — avoids false positives like 'restart #2'", () => {
      const ids = extractor.extractWorkItemIds("Gateway restart #2");
      expect(ids).toHaveLength(0);
    });

    it("does not extract bare #NNN from natural language", () => {
      const ids = extractor.extractWorkItemIds("See #42 for details");
      expect(ids).toHaveLength(0);
    });
  });

  describe("mixed extraction", () => {
    it("extracts only known-prefix tickets, ignores PR references", () => {
      const ids = extractor.extractWorkItemIds("OPS-382: submitted PR #716 for review");
      expect(ids).toContain("OPS-382");
      expect(ids).not.toContain("PR-716");
      expect(ids).toHaveLength(1);
    });

    it("handles multiline text", () => {
      const text = `Status update:
- OPS-100: completed
- ENG-200: in progress
- PR #50 submitted`;
      const ids = extractor.extractWorkItemIds(text);
      expect(ids).toContain("OPS-100");
      expect(ids).toContain("ENG-200");
      expect(ids).toHaveLength(2); // PR-50 not extracted
    });
  });

  describe("edge cases", () => {
    it("handles empty text", () => {
      expect(extractor.extractWorkItemIds("")).toHaveLength(0);
    });

    it("handles text with only whitespace", () => {
      expect(extractor.extractWorkItemIds("   \n\t  ")).toHaveLength(0);
    });

    it("does not match single-letter prefixes", () => {
      const ids = extractor.extractWorkItemIds("A-123");
      expect(ids).toHaveLength(0);
    });

    it("accepts all ticket patterns when no prefixes configured", () => {
      const noPrefixes = new DefaultExtractor({
        ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
        prPatterns: [],
        ticketPrefixes: [],
      });
      const ids = noPrefixes.extractWorkItemIds("DEPLOY-123 and UI-5");
      expect(ids).toContain("DEPLOY-123");
      expect(ids).toContain("UI-5");
    });

    it("works with custom prefixes", () => {
      const custom = new DefaultExtractor({
        ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
        prPatterns: [],
        ticketPrefixes: ["FEAT-"],
      });
      const ids = custom.extractWorkItemIds("Working on FEAT-42 and OPS-100");
      expect(ids).toContain("FEAT-42");
      expect(ids).not.toContain("OPS-100");
    });
  });
});
