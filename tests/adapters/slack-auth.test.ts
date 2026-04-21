import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../../core/adapters/messaging/slack/index.js";

describe("SlackAdapter.getAuthenticatedUser", () => {
  it("returns null before connect", () => {
    const adapter = new SlackAdapter();
    expect(adapter.getAuthenticatedUser()).toBeNull();
  });

  it("returns null from a second instance (independent state)", () => {
    const adapter = new SlackAdapter();
    expect(adapter.getAuthenticatedUser()).toBeNull();
  });
});
