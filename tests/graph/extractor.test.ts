// tests/graph/extractor.test.ts — Regex extractor edge cases

import { describe, it, expect } from "vitest";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

const defaultConfig = {
  ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"],
  prPatterns: ["PR\\s*#?(\\d+)", "#(\\d+)"],
};

describe("DefaultExtractor", () => {
  const extractor = new DefaultExtractor(defaultConfig);

  describe("ticket extraction", () => {
    it("extracts standard Jira-style tickets", () => {
      const ids = extractor.extractWorkItemIds("Working on AI-382 now");
      expect(ids).toContain("AI-382");
    });

    it("extracts multiple tickets", () => {
      const ids = extractor.extractWorkItemIds("Linked AI-382 to IT-100 and MS-112");
      expect(ids).toContain("AI-382");
      expect(ids).toContain("IT-100");
      expect(ids).toContain("MS-112");
    });

    it("handles 2-letter prefixes", () => {
      const ids = extractor.extractWorkItemIds("Fix for IT-5");
      expect(ids).toContain("IT-5");
    });

    it("handles 6-letter prefixes", () => {
      const ids = extractor.extractWorkItemIds("See DEPLOY-123");
      expect(ids).toContain("DEPLOY-123");
    });

    it("ignores lowercase prefixes", () => {
      const ids = extractor.extractWorkItemIds("working on ai-382");
      const tickets = ids.filter((id) => !id.startsWith("PR-"));
      expect(tickets).toHaveLength(0);
    });

    it("deduplicates repeated ticket IDs", () => {
      const ids = extractor.extractWorkItemIds("AI-1 is related to AI-1");
      const tickets = ids.filter((id) => !id.startsWith("PR-"));
      expect(tickets).toEqual(["AI-1"]);
    });

    it("handles tickets at start and end of text", () => {
      const ids = extractor.extractWorkItemIds("AI-100 done");
      expect(ids).toContain("AI-100");

      const ids2 = extractor.extractWorkItemIds("done AI-100");
      expect(ids2).toContain("AI-100");
    });

    it("returns empty for text with no tickets", () => {
      const ids = extractor.extractWorkItemIds("Just a regular message with no references");
      expect(ids).toHaveLength(0);
    });
  });

  describe("PR extraction", () => {
    it("extracts PR #NNN format", () => {
      const ids = extractor.extractWorkItemIds("Review PR #716");
      expect(ids).toContain("PR-716");
    });

    it("extracts PR NNN format (no hash)", () => {
      const ids = extractor.extractWorkItemIds("Review PR 42");
      expect(ids).toContain("PR-42");
    });

    it("extracts #NNN format", () => {
      const ids = extractor.extractWorkItemIds("See #42 for details");
      expect(ids).toContain("PR-42");
    });

    it("extracts multiple PRs", () => {
      const ids = extractor.extractWorkItemIds("PR #1 and PR #2 are ready");
      expect(ids).toContain("PR-1");
      expect(ids).toContain("PR-2");
    });

    it("deduplicates PR references matched by different patterns", () => {
      const ids = extractor.extractWorkItemIds("PR #42 see #42");
      const prIds = ids.filter((id) => id.startsWith("PR-"));
      expect(prIds).toEqual(["PR-42"]);
    });
  });

  describe("mixed extraction", () => {
    it("extracts both tickets and PRs from the same text", () => {
      const ids = extractor.extractWorkItemIds("AI-382: submitted PR #716 for review");
      expect(ids).toContain("AI-382");
      expect(ids).toContain("PR-716");
    });

    it("handles multiline text", () => {
      const text = `Status update:
- AI-100: completed
- IT-200: in progress
- PR #50 submitted`;
      const ids = extractor.extractWorkItemIds(text);
      expect(ids).toContain("AI-100");
      expect(ids).toContain("IT-200");
      expect(ids).toContain("PR-50");
    });
  });

  describe("edge cases", () => {
    it("handles empty text", () => {
      expect(extractor.extractWorkItemIds("")).toHaveLength(0);
    });

    it("handles text with only whitespace", () => {
      expect(extractor.extractWorkItemIds("   \n\t  ")).toHaveLength(0);
    });

    it("does not match partial patterns", () => {
      // Single letter prefix should not match
      const ids = extractor.extractWorkItemIds("A-123");
      const tickets = ids.filter((id) => !id.startsWith("PR-"));
      expect(tickets).toHaveLength(0);
    });

    it("works with custom patterns", () => {
      const custom = new DefaultExtractor({
        ticketPatterns: ["\\b(FEAT-\\d+)\\b"],
        prPatterns: [],
      });
      const ids = custom.extractWorkItemIds("Working on FEAT-42");
      expect(ids).toContain("FEAT-42");
    });
  });
});
