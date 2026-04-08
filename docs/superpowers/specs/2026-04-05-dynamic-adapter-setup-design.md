# Dynamic Adapter Setup Forms — Design Spec

## Goal

Replace hardcoded Slack/Jira setup fields with a data-driven form. Each adapter declares its credential schema via `getSetupInfo()`. The Setup page renders fields dynamically based on registered adapters. Community adapters get a working setup form for free.

## Architecture

Three layers change:

1. **Adapter layer** — adapters implement `getSetupInfo()` returning field definitions
2. **API layer** — new endpoint serves adapter schemas; existing setup endpoints use structured payloads
3. **Frontend layer** — Setup.tsx renders form sections from API data instead of hardcoded JSX

LLM provider configuration stays as-is (frontend presets). It's a fundamentally different pattern — stateless API endpoints, not persistent adapter connections.

---

## 1. Adapter Setup Interface

### Types

```typescript
// core/adapters/setup.ts (new file)

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
```

### MessagingAdapter and TaskAdapter interfaces

Add to both interfaces:

```typescript
// Required — declares setup form fields
getSetupInfo(): AdapterSetupInfo;

// Optional — transforms raw form values before connect()
// e.g. Jira base64-encodes email:token into a single auth token
prepareCredentials?(fields: Record<string, string>): Record<string, string>;
```

### Slack adapter implementation

```typescript
getSetupInfo(): AdapterSetupInfo {
  return {
    name: "slack",
    displayName: "Slack",
    helpUrl: "https://api.slack.com/apps",
    fields: [
      {
        key: "token",
        label: "Token",
        type: "password",
        required: true,
        placeholder: "xoxp-...",
        helpText: "Needs scopes: channels:history, channels:read, chat:write, users:read",
        envVar: "ATC_SLACK_TOKEN",
      },
    ],
  };
}
```

### Jira adapter implementation

```typescript
getSetupInfo(): AdapterSetupInfo {
  return {
    name: "jira",
    displayName: "Jira",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      {
        key: "email",
        label: "Email",
        type: "email",
        required: true,
        placeholder: "you@company.com",
        envVar: "ATC_JIRA_EMAIL",
      },
      {
        key: "token",
        label: "API Token",
        type: "password",
        required: true,
        placeholder: "Jira API token",
        envVar: "ATC_JIRA_API_TOKEN",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        required: true,
        placeholder: "https://your-org.atlassian.net",
        envVar: "ATC_JIRA_BASE_URL",
      },
    ],
  };
}
```

### Credentials mapping

The adapter's `connect(credentials)` already receives a generic `Credentials` object. The form field values (keyed by `SetupField.key`) are passed directly as credentials. Slack receives `{ token: "xoxp-..." }`. Jira receives `{ email: "...", token: "...", baseUrl: "..." }`.

For Jira, the adapter's `connect()` expects `{ token, baseUrl }` where `token` is the base64-encoded `email:apitoken` string. The setup handler derives this from the `email` and `token` form fields before calling `connect()`. This credential preparation logic moves into the Jira adapter itself — a new optional `prepareCredentials(fields)` method on the adapter interface that transforms raw form values into the format `connect()` expects. If not implemented, `fields` are passed to `connect()` as-is (Slack's case).

---

## 2. Adapter Registry Changes

The registry needs to support calling `getSetupInfo()` without fully instantiating and connecting an adapter. Since adapters self-register with factory functions, the registry creates a temporary instance to call `getSetupInfo()`.

Add to `core/adapters/registry.ts`:

```typescript
export function getMessagingAdapterSetupInfo(): AdapterSetupInfo[] {
  return getRegisteredMessagingAdapters().map((name) => {
    const adapter = createMessagingAdapter(name);
    return adapter.getSetupInfo();
  });
}

export function getTaskAdapterSetupInfo(): AdapterSetupInfo[] {
  return getRegisteredTaskAdapters().map((name) => {
    const adapter = createTaskAdapter(name);
    return adapter.getSetupInfo();
  });
}
```

---

## 3. API Changes

### `GET /api/setup/adapters` (new endpoint)

Returns registered adapters grouped by category with their field schemas.

```typescript
// Response shape
{
  messaging: AdapterSetupInfo[],
  task: AdapterSetupInfo[]
}
```

Example response:

```json
{
  "messaging": [
    {
      "name": "slack",
      "displayName": "Slack",
      "helpUrl": "https://api.slack.com/apps",
      "fields": [
        {
          "key": "token",
          "label": "Token",
          "type": "password",
          "required": true,
          "placeholder": "xoxp-...",
          "helpText": "Needs scopes: channels:history, channels:read, chat:write, users:read"
        }
      ]
    }
  ],
  "task": [
    {
      "name": "jira",
      "displayName": "Jira",
      "helpUrl": "https://id.atlassian.com/manage-profile/security/api-tokens",
      "fields": [
        { "key": "email", "label": "Email", "type": "email", "required": true, "placeholder": "you@company.com" },
        { "key": "token", "label": "API Token", "type": "password", "required": true, "placeholder": "Jira API token" },
        { "key": "baseUrl", "label": "Base URL", "type": "url", "required": true, "placeholder": "https://your-org.atlassian.net" }
      ]
    }
  ]
}
```

Note: `envVar` is stripped from the response — it's server-internal for prefill logic. The frontend never sees env var names.

### `POST /api/setup` (restructured payload)

```typescript
// Request payload
{
  messaging?: {
    adapter: string;              // "slack"
    fields: Record<string, string>; // { token: "xoxp-..." }
  };
  task?: {
    adapter: string;              // "jira"
    fields: Record<string, string>; // { email: "...", token: "...", baseUrl: "..." }
  };
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  rateLimits?: Record<string, number>;
}
```

The handler logic becomes generic:

1. For `messaging` and `task` sections:
   - Look up adapter by name in registry
   - Get `SetupInfo` to find `envVar` for each field
   - Write credentials to `.env` using the declared `envVar` names
   - Write non-sensitive config to `config/local.yaml` where applicable
   - Set process env vars
   - Create adapter instance, call `connect(fields)`
2. For `llm`:
   - Same logic as today, just nested under `body.llm`
3. For `rateLimits`:
   - Same logic as today

### `GET /api/setup/prefill` (restructured response)

```typescript
// Response shape
{
  messaging?: {
    adapter: string;
    fields: Record<string, string>;  // values read from envVar declarations
  };
  task?: {
    adapter: string;
    fields: Record<string, string>;
  };
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  rateLimits: Record<string, { maxPerMinute: number; displayName: string }>;
}
```

The server iterates each registered adapter's `SetupField` entries, reads the `envVar` for each, and returns non-empty values. If any fields are prefilled, the adapter name is included so the frontend knows which adapter to pre-select.

### `GET /api/setup/status` (restructured response)

```typescript
// Response shape
{
  configured: boolean;
  llm: boolean;
  adapters: {
    messaging: { name: string; connected: boolean } | null;
    task: { name: string; connected: boolean } | null;
  };
  platformMeta: Record<string, unknown>;
}
```

Replaces hardcoded `slack: boolean` and `jira: boolean` with a dynamic `adapters` object. The frontend uses adapter names for display (light bulb labels).

---

## 4. Frontend Changes

### New component: `AdapterFieldGroup`

A generic component that renders form fields from a `SetupField[]` array.

```typescript
interface AdapterFieldGroupProps {
  fields: SetupField[];
  values: Record<string, string>;
  envFields: Record<string, boolean>;  // which fields came from env
  onChange: (key: string, value: string) => void;
}
```

Renders each field as the appropriate input type, with label, placeholder, help text, and "from env" badge. About 40-50 lines — a loop over fields with a switch on `field.type`.

### Setup.tsx changes

1. **On mount**: fetches `GET /api/setup/adapters` alongside the existing prefill call
2. **Three fieldset sections**: Messaging, LLM, Task
3. **Messaging and Task sections**:
   - If one adapter registered: section title = adapter `displayName`, no selector
   - If multiple: section title = category name ("Messaging" / "Task"), button row selector underneath (same pattern as LLM presets)
   - Fields rendered via `<AdapterFieldGroup>` from selected adapter's schema
   - "Get token →" link from adapter's `helpUrl`
4. **LLM section**: unchanged — hardcoded presets stay as-is
5. **Rate limits section**: unchanged — already dynamic
6. **On submit**: builds new structured payload (`{ messaging: { adapter, fields }, task: { adapter, fields }, llm: { ... } }`)

### api.ts type changes

```typescript
// Replaces flat SetupConfig
interface SetupPayload {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm?: { apiKey: string; baseUrl: string; model: string };
  rateLimits?: Record<string, number>;
}

// New
interface AdapterSetupInfo {
  name: string;
  displayName: string;
  fields: SetupField[];
  helpUrl?: string;
}

interface SetupAdaptersResponse {
  messaging: AdapterSetupInfo[];
  task: AdapterSetupInfo[];
}

// Updated
interface SetupStatus {
  configured: boolean;
  llm: boolean;
  adapters: {
    messaging: { name: string; connected: boolean } | null;
    task: { name: string; connected: boolean } | null;
  };
  platformMeta: Record<string, unknown>;
}
```

### Status indicator changes

Whatever component renders the light bulb indicators reads from `status.adapters.messaging` and `status.adapters.task` instead of hardcoded `status.slack` and `status.jira`. Labels come from adapter names.

---

## 5. What stays the same

- **Adapter interfaces** (`MessagingAdapter`, `TaskAdapter`) — unchanged except adding `getSetupInfo()`
- **Adapter registry** — `registerMessagingAdapter` / `createMessagingAdapter` work as before, plus new `getMessagingAdapterSetupInfo()` helper
- **`connect(credentials)`** — already generic, receives field values directly
- **LLM provider presets** — stay in the frontend, no adapter pattern
- **Rate limits section** — already dynamic
- **Config file format** — `config/local.yaml` structure unchanged
- **Adapter discovery at boot** — still explicit `await import(...)`, no dynamic scanning

---

## 6. Migration

The old flat `SetupConfig` type and flat `POST /api/setup` payload are replaced, not deprecated. This is a breaking change to the setup API, but:
- The setup API is internal (frontend ↔ backend on localhost)
- There are no external consumers
- The frontend and backend ship together as one Tauri app

No backwards compatibility shim needed.

---

## 7. Testing

- **Unit tests for `getSetupInfo()`** on Slack and Jira adapters — verify field schemas match expected shape
- **API test for `GET /api/setup/adapters`** — verify response includes registered adapters with correct fields
- **API test for `POST /api/setup`** — verify structured payload correctly writes env vars and connects adapters
- **API test for `GET /api/setup/prefill`** — verify env var values are returned under correct adapter/field keys
- **Existing setup tests** — update to use new payload shape
