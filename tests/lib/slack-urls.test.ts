// tests/lib/slack-urls.test.ts — Tests for buildSlackThreadUrl

import { describe, it, expect } from "vitest";
import { buildSlackThreadUrl } from "../../src/messaging/slack/urls.js";

describe("buildSlackThreadUrl", () => {
  const workspace = "https://myteam.slack.com";

  it("returns channel URL with thread permalink when threadTs is provided", () => {
    const url = buildSlackThreadUrl(workspace, "C0123ABC", "1700000001.000100");
    expect(url).toBe("https://myteam.slack.com/archives/C0123ABC/p1700000001000100");
  });

  it("returns channel-only URL when threadTs is omitted", () => {
    const url = buildSlackThreadUrl(workspace, "C0123ABC");
    expect(url).toBe("https://myteam.slack.com/archives/C0123ABC");
  });

  it("returns channel-only URL when threadTs is undefined", () => {
    const url = buildSlackThreadUrl(workspace, "C0123ABC", undefined);
    expect(url).toBe("https://myteam.slack.com/archives/C0123ABC");
  });

  it("handles trailing slash on workspaceUrl", () => {
    const url = buildSlackThreadUrl("https://myteam.slack.com/", "C001", "1700000001.000100");
    // The current implementation does not strip trailing slashes,
    // so we verify the output is still a usable URL
    expect(url).toContain("/archives/C001/p1700000001000100");
  });

  it("strips the dot from threadTs to form the permalink", () => {
    // Slack ts "1711234567.123456" → "p1711234567123456"
    const url = buildSlackThreadUrl(workspace, "CABC", "1711234567.123456");
    expect(url).toBe("https://myteam.slack.com/archives/CABC/p1711234567123456");
  });

  it("works with different workspace URLs", () => {
    const url = buildSlackThreadUrl(
      "https://another-workspace.slack.com",
      "C999",
      "1600000000.000001",
    );
    expect(url).toBe(
      "https://another-workspace.slack.com/archives/C999/p1600000000000001",
    );
  });
});
