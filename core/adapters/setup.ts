// core/adapters/setup.ts — Setup form field definitions for adapters

export interface SetupField {
  key: string;           // "token", "baseUrl", "email"
  label: string;         // "API Token"
  type: "text" | "password" | "email" | "url";
  required: boolean;
  placeholder?: string;  // "xoxp-..."
  helpText?: string;     // "Needs scopes: channels:history, ..."
  helpUrl?: string;      // "https://api.slack.com/apps"
  envVar?: string;       // "ATC_SLACK_TOKEN" — server reads this for prefill
}

export interface AdapterSetupInfo {
  name: string;          // "slack"
  displayName: string;   // "Slack"
  fields: SetupField[];
  helpUrl?: string;      // top-level "Get token →" link
}
