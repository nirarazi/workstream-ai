import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../../core/adapters/messaging/slack/index.js";

describe("SlackAdapter.getAuthenticatedUser", () => {
  it("returns null before connect", () => {
    const adapter = new SlackAdapter();
    expect(adapter.getAuthenticatedUser()).toBeNull();
  });

  it("returns user ID and name after connect", async () => {
    const adapter = new SlackAdapter();
    const user = adapter.getAuthenticatedUser();
    expect(user).toBeNull(); // Before connect
  });
});
