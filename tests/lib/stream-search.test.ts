import { describe, it, expect } from "vitest";
import { matchesSearch } from "../../src/lib/stream-search.js";
import type { ActionableItem } from "../../src/lib/api.js";

const item = {
  workItem: { id: "OPS-101", title: "Lane credential expired" },
  agent: { name: "Atlas" },
  thread: { channelName: "fleet-alerts" },
  latestEvent: { rawText: "Re-login needed on account 7", reason: "Agent is blocked on a login" },
} as unknown as ActionableItem;

describe("Stream search", () => {
  it("matches the ticket ID, title, agent, channel and latest message, ignoring case", () => {
    for (const q of ["ops-101", "credential", "atlas", "fleet-alerts", "re-login", "blocked on a login"]) {
      expect(matchesSearch(item, q)).toBe(true);
    }
  });

  it("requires every word to match somewhere", () => {
    expect(matchesSearch(item, "atlas expired")).toBe(true);
    expect(matchesSearch(item, "atlas deploy")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesSearch(item, "  ")).toBe(true);
  });
});
