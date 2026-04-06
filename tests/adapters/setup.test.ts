import { describe, it, expect } from "vitest";
import type { SetupField, AdapterSetupInfo } from "../../core/adapters/setup.js";

describe("Setup types", () => {
  it("SetupField has required shape", () => {
    const field: SetupField = {
      key: "token",
      label: "API Token",
      type: "password",
      required: true,
      placeholder: "xoxp-...",
      helpText: "Needs scopes: channels:history",
      helpUrl: "https://api.slack.com/apps",
      envVar: "ATC_SLACK_TOKEN",
    };

    expect(field.key).toBe("token");
    expect(field.type).toBe("password");
    expect(field.required).toBe(true);
    expect(field.envVar).toBe("ATC_SLACK_TOKEN");
  });

  it("AdapterSetupInfo has required shape", () => {
    const info: AdapterSetupInfo = {
      name: "slack",
      displayName: "Slack",
      helpUrl: "https://api.slack.com/apps",
      fields: [
        {
          key: "token",
          label: "Token",
          type: "password",
          required: true,
        },
      ],
    };

    expect(info.name).toBe("slack");
    expect(info.displayName).toBe("Slack");
    expect(info.fields).toHaveLength(1);
    expect(info.fields[0].key).toBe("token");
  });

  it("SetupField type union covers all input types", () => {
    const types: SetupField["type"][] = ["text", "password", "email", "url"];
    expect(types).toHaveLength(4);
  });
});
