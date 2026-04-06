import { describe, it, expect } from "vitest";

// Import the adapters to trigger self-registration
import "../../core/adapters/messaging/slack/index.js";
import "../../core/adapters/tasks/jira/index.js";

import {
  getMessagingAdapterSetupInfo,
  getTaskAdapterSetupInfo,
} from "../../core/adapters/registry.js";

describe("getMessagingAdapterSetupInfo()", () => {
  it("returns setup info for all registered messaging adapters", () => {
    const infos = getMessagingAdapterSetupInfo();

    expect(infos.length).toBeGreaterThan(0);
    const slack = infos.find((i) => i.name === "slack");
    expect(slack).toBeDefined();
    expect(slack!.displayName).toBe("Slack");
    expect(slack!.fields.length).toBeGreaterThan(0);
  });
});

describe("getTaskAdapterSetupInfo()", () => {
  it("returns setup info for all registered task adapters", () => {
    const infos = getTaskAdapterSetupInfo();

    expect(infos.length).toBeGreaterThan(0);
    const jira = infos.find((i) => i.name === "jira");
    expect(jira).toBeDefined();
    expect(jira!.displayName).toBe("Jira");
    expect(jira!.fields.length).toBe(3);
  });
});
