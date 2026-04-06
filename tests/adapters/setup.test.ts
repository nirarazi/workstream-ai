import { describe, it, expect } from "vitest";
import type { SetupField, AdapterSetupInfo } from "../../core/adapters/setup.js";
import { SlackAdapter } from "../../core/adapters/messaging/slack/index.js";
import { JiraAdapter } from "../../core/adapters/tasks/jira/index.js";

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

describe("SlackAdapter.getSetupInfo()", () => {
  it("returns valid setup info", () => {
    const adapter = new SlackAdapter();
    const info = adapter.getSetupInfo();

    expect(info.name).toBe("slack");
    expect(info.displayName).toBe("Slack");
    expect(info.helpUrl).toBeDefined();
    expect(info.fields.length).toBeGreaterThan(0);
  });

  it("declares token field with correct properties", () => {
    const adapter = new SlackAdapter();
    const info = adapter.getSetupInfo();
    const tokenField = info.fields.find((f) => f.key === "token");

    expect(tokenField).toBeDefined();
    expect(tokenField!.type).toBe("password");
    expect(tokenField!.required).toBe(true);
    expect(tokenField!.envVar).toBe("ATC_SLACK_TOKEN");
  });
});

describe("JiraAdapter.getSetupInfo()", () => {
  it("returns valid setup info", () => {
    const adapter = new JiraAdapter();
    const info = adapter.getSetupInfo();

    expect(info.name).toBe("jira");
    expect(info.displayName).toBe("Jira");
    expect(info.helpUrl).toBeDefined();
    expect(info.fields.length).toBe(3);
  });

  it("declares email, token, and baseUrl fields", () => {
    const adapter = new JiraAdapter();
    const info = adapter.getSetupInfo();
    const keys = info.fields.map((f) => f.key);

    expect(keys).toContain("email");
    expect(keys).toContain("token");
    expect(keys).toContain("baseUrl");
  });

  it("has correct envVar mappings", () => {
    const adapter = new JiraAdapter();
    const info = adapter.getSetupInfo();
    const envVars = Object.fromEntries(info.fields.map((f) => [f.key, f.envVar]));

    expect(envVars.email).toBe("ATC_JIRA_EMAIL");
    expect(envVars.token).toBe("ATC_JIRA_API_TOKEN");
    expect(envVars.baseUrl).toBe("ATC_JIRA_BASE_URL");
  });
});

describe("JiraAdapter.prepareCredentials()", () => {
  it("base64-encodes email:token into token field", () => {
    const adapter = new JiraAdapter();
    const result = adapter.prepareCredentials!({
      email: "user@example.com",
      token: "api_token",
      baseUrl: "https://test.atlassian.net",
    });

    expect(result.token).toBe(Buffer.from("user@example.com:api_token").toString("base64"));
    expect(result.baseUrl).toBe("https://test.atlassian.net");
    expect(result.email).toBeUndefined();
  });
});
