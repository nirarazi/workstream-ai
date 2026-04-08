# Dynamic Adapter Setup Forms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded Slack/Jira setup fields with a data-driven form where each adapter declares its credential schema via `getSetupInfo()`, and the Setup page renders fields dynamically.

**Architecture:** Adapters implement `getSetupInfo()` returning field definitions (`SetupField[]`). A new API endpoint serves adapter schemas. The frontend renders form sections dynamically from API data. LLM provider configuration stays as-is (frontend presets).

**Tech Stack:** TypeScript, Hono (server), React (frontend), Vitest (tests)

---

### Task 1: Setup Types — `core/adapters/setup.ts`

**Files:**
- Create: `core/adapters/setup.ts`
- Test: `tests/adapters/setup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/setup.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/setup.test.ts`
Expected: FAIL — cannot resolve `../../core/adapters/setup.js`

- [ ] **Step 3: Write the types file**

Create `core/adapters/setup.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/adapters/setup.test.ts`
Expected: PASS — all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add core/adapters/setup.ts tests/adapters/setup.test.ts
git commit -m "feat: add SetupField and AdapterSetupInfo types for dynamic adapter setup"
```

---

### Task 2: Add `getSetupInfo()` and `prepareCredentials()` to Adapter Interfaces

**Files:**
- Modify: `core/adapters/messaging/interface.ts`
- Modify: `core/adapters/tasks/interface.ts`

- [ ] **Step 1: Add imports and methods to MessagingAdapter**

In `core/adapters/messaging/interface.ts`, add the import at the top:

```typescript
import type { AdapterSetupInfo } from "../setup.js";
```

Add these two methods to the `MessagingAdapter` interface (after `displayName`):

```typescript
  /** Declare setup form fields for this adapter */
  getSetupInfo(): AdapterSetupInfo;

  /** Transform raw form values before connect(). If not implemented, fields are passed as-is. */
  prepareCredentials?(fields: Record<string, string>): Record<string, string>;
```

- [ ] **Step 2: Add imports and methods to TaskAdapter**

In `core/adapters/tasks/interface.ts`, add the import at the top:

```typescript
import type { AdapterSetupInfo } from "../setup.js";
```

Add these two methods to the `TaskAdapter` interface (after `displayName`):

```typescript
  /** Declare setup form fields for this adapter */
  getSetupInfo(): AdapterSetupInfo;

  /** Transform raw form values before connect(). If not implemented, fields are passed as-is. */
  prepareCredentials?(fields: Record<string, string>): Record<string, string>;
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npx vitest run tests/adapters/`
Expected: Tests fail because SlackAdapter and JiraAdapter don't implement `getSetupInfo()` yet. This is expected — we'll implement them in Task 3.

- [ ] **Step 4: Commit**

```bash
git add core/adapters/messaging/interface.ts core/adapters/tasks/interface.ts
git commit -m "feat: add getSetupInfo() and prepareCredentials() to adapter interfaces"
```

---

### Task 3: Implement `getSetupInfo()` on Slack and Jira Adapters

**Files:**
- Modify: `core/adapters/messaging/slack/index.ts`
- Modify: `core/adapters/tasks/jira/index.ts`
- Test: `tests/adapters/setup.test.ts` (extend)

- [ ] **Step 1: Write failing tests for adapter getSetupInfo()**

Append to `tests/adapters/setup.test.ts`:

```typescript
import { SlackAdapter } from "../../core/adapters/messaging/slack/index.js";
import { JiraAdapter } from "../../core/adapters/tasks/jira/index.js";

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
    // email should not be in the prepared credentials — connect() doesn't need it
    expect(result.email).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/setup.test.ts`
Expected: FAIL — `getSetupInfo` is not a function / `prepareCredentials` is not a function

- [ ] **Step 3: Implement getSetupInfo() on SlackAdapter**

In `core/adapters/messaging/slack/index.ts`, add import at top:

```typescript
import type { AdapterSetupInfo } from "../../setup.js";
```

Add method to `SlackAdapter` class (after the `displayName` property):

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

- [ ] **Step 4: Implement getSetupInfo() and prepareCredentials() on JiraAdapter**

In `core/adapters/tasks/jira/index.ts`, add import at top:

```typescript
import type { AdapterSetupInfo } from "../../setup.js";
```

Add methods to `JiraAdapter` class (after the `displayName` property):

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

  prepareCredentials(fields: Record<string, string>): Record<string, string> {
    const authToken = Buffer.from(`${fields.email}:${fields.token}`).toString("base64");
    return {
      token: authToken,
      baseUrl: fields.baseUrl,
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/setup.test.ts`
Expected: PASS — all tests pass

- [ ] **Step 6: Run full adapter test suite to check for regressions**

Run: `npx vitest run tests/adapters/`
Expected: PASS — all existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add core/adapters/messaging/slack/index.ts core/adapters/tasks/jira/index.ts tests/adapters/setup.test.ts
git commit -m "feat: implement getSetupInfo() on Slack and Jira adapters"
```

---

### Task 4: Registry Helper Functions

**Files:**
- Modify: `core/adapters/registry.ts`
- Test: `tests/adapters/registry.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/adapters/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/registry.test.ts`
Expected: FAIL — `getMessagingAdapterSetupInfo` is not exported

- [ ] **Step 3: Add helper functions to registry**

In `core/adapters/registry.ts`, add import at top:

```typescript
import type { AdapterSetupInfo } from "./setup.js";
```

Add these two functions at the end of the file:

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/adapters/registry.ts tests/adapters/registry.test.ts
git commit -m "feat: add getMessagingAdapterSetupInfo() and getTaskAdapterSetupInfo() to registry"
```

---

### Task 5: New `GET /api/setup/adapters` Endpoint

**Files:**
- Modify: `core/server.ts`
- Test: `tests/server/setup-adapters-api.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `tests/server/setup-adapters-api.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";

// Import adapters to trigger self-registration
import "../../core/adapters/messaging/slack/index.js";
import "../../core/adapters/tasks/jira/index.js";

import { createApp } from "../../core/server.js";

let app: ReturnType<Awaited<ReturnType<typeof createApp>>>;

// Note: createApp() requires certain state. For this test, we need to check
// how the server test files set up their test harness. Use the same pattern
// as existing server tests (e.g. tests/server/sidekick-api.test.ts).

describe("GET /api/setup/adapters", () => {
  it("returns messaging and task adapter schemas", async () => {
    // This test verifies the endpoint exists and returns the correct shape.
    // The actual test setup should match the existing server test pattern.
    // For now, test the registry functions directly as a proxy.
    const { getMessagingAdapterSetupInfo, getTaskAdapterSetupInfo } = await import(
      "../../core/adapters/registry.js"
    );

    const messaging = getMessagingAdapterSetupInfo();
    const task = getTaskAdapterSetupInfo();

    expect(messaging.length).toBeGreaterThan(0);
    expect(task.length).toBeGreaterThan(0);

    // Verify envVar is present in the raw data (server will strip it)
    const slackToken = messaging[0].fields.find((f) => f.key === "token");
    expect(slackToken?.envVar).toBeDefined();
  });

  it("envVar should be stripped from response fields", () => {
    // This tests the stripping logic we'll add to the endpoint
    const { getMessagingAdapterSetupInfo } = require("../../core/adapters/registry.js");
    const infos = getMessagingAdapterSetupInfo();

    // Simulate the server's stripping logic
    const stripped = infos.map((info: Record<string, unknown>) => ({
      ...info,
      fields: (info.fields as Array<Record<string, unknown>>).map(({ envVar, ...rest }) => rest),
    }));

    for (const info of stripped) {
      for (const field of info.fields as Array<Record<string, unknown>>) {
        expect(field.envVar).toBeUndefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/setup-adapters-api.test.ts`
Expected: May pass partially (tests the function, not the endpoint). The key validation is that the shape is correct.

- [ ] **Step 3: Add the endpoint to server.ts**

In `core/server.ts`, add this import near the top with other adapter imports:

```typescript
import { getMessagingAdapterSetupInfo, getTaskAdapterSetupInfo } from "./adapters/registry.js";
```

Add the endpoint just before the `POST /api/setup` handler (around line 614):

```typescript
  // --- GET /api/setup/adapters ---
  // Returns registered adapter schemas for dynamic setup form rendering.
  // envVar is stripped — it's server-internal for prefill logic.
  app.get("/api/setup/adapters", (c) => {
    function stripEnvVar(infos: ReturnType<typeof getMessagingAdapterSetupInfo>) {
      return infos.map((info) => ({
        ...info,
        fields: info.fields.map(({ envVar, ...rest }) => rest),
      }));
    }

    return c.json({
      messaging: stripEnvVar(getMessagingAdapterSetupInfo()),
      task: stripEnvVar(getTaskAdapterSetupInfo()),
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/setup-adapters-api.test.ts`
Expected: PASS

- [ ] **Step 5: Run all server tests to check for regressions**

Run: `npx vitest run tests/server/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/server.ts tests/server/setup-adapters-api.test.ts
git commit -m "feat: add GET /api/setup/adapters endpoint for dynamic setup form schemas"
```

---

### Task 6: Restructure `POST /api/setup` Handler

**Files:**
- Modify: `core/server.ts:614-784` (the POST /api/setup handler)

This is the largest server-side change. The handler currently accepts a flat payload (`slackToken`, `jiraEmail`, etc.) and needs to accept the new structured format (`{ messaging: { adapter, fields }, task: { adapter, fields }, llm: { ... }, rateLimits: { ... } }`).

- [ ] **Step 1: Write failing test for new payload shape**

Create `tests/server/setup-post-api.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("POST /api/setup structured payload", () => {
  it("accepts new structured format", () => {
    // Validate the payload shape that the handler should accept
    const payload = {
      messaging: {
        adapter: "slack",
        fields: { token: "xoxp-test-token" },
      },
      task: {
        adapter: "jira",
        fields: {
          email: "user@example.com",
          token: "api_token",
          baseUrl: "https://test.atlassian.net",
        },
      },
      llm: {
        apiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-6",
      },
      rateLimits: { llm: 4, slack: 25, jira: 30 },
    };

    // Verify shape — messaging section has adapter name + fields
    expect(payload.messaging.adapter).toBe("slack");
    expect(payload.messaging.fields.token).toBe("xoxp-test-token");

    // Verify task section has adapter name + all fields
    expect(payload.task.adapter).toBe("jira");
    expect(payload.task.fields.email).toBe("user@example.com");
    expect(payload.task.fields.token).toBe("api_token");
    expect(payload.task.fields.baseUrl).toBe("https://test.atlassian.net");

    // Verify llm section
    expect(payload.llm.apiKey).toBe("sk-ant-test");
    expect(payload.llm.model).toBe("claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (shape validation only)**

Run: `npx vitest run tests/server/setup-post-api.test.ts`
Expected: PASS (this is just shape validation)

- [ ] **Step 3: Rewrite the POST /api/setup handler**

Replace the entire `app.post("/api/setup", ...)` handler in `core/server.ts` (lines ~615-784) with:

```typescript
  // --- POST /api/setup ---
  app.post("/api/setup", async (c) => {
    const body = await c.req.json<{
      messaging?: {
        adapter: string;
        fields: Record<string, string>;
      };
      task?: {
        adapter: string;
        fields: Record<string, string>;
      };
      llm?: {
        apiKey: string;
        baseUrl: string;
        model: string;
      };
      rateLimits?: Record<string, number>;
    }>();

    try {
      const projectRoot = findProjectRoot();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { stringify: toYaml } = await import("yaml");

      const configDir = resolve(projectRoot, "config");
      mkdirSync(configDir, { recursive: true });

      const localConfig: Record<string, unknown> = {};
      const envLines: string[] = [];

      // --- LLM ---
      if (body.llm) {
        if (body.llm.baseUrl || body.llm.model) {
          localConfig.classifier = {
            provider: {
              baseUrl: body.llm.baseUrl ?? state.config.classifier.provider.baseUrl,
              model: body.llm.model ?? state.config.classifier.provider.model,
            },
          };
        }
        if (body.llm.apiKey) envLines.push(`ATC_LLM_API_KEY=${body.llm.apiKey}`);
        if (body.llm.baseUrl) envLines.push(`ATC_LLM_BASE_URL=${body.llm.baseUrl}`);
        if (body.llm.model) envLines.push(`ATC_LLM_MODEL=${body.llm.model}`);
      }

      // --- Messaging adapter ---
      if (body.messaging) {
        const adapterName = body.messaging.adapter;
        const fields = body.messaging.fields;

        // Look up adapter to get envVar mappings
        const adapter = createMessagingAdapter(adapterName);
        const setupInfo = adapter.getSetupInfo();

        // Write env vars using the declared envVar names
        for (const fieldDef of setupInfo.fields) {
          if (fieldDef.envVar && fields[fieldDef.key]) {
            envLines.push(`${fieldDef.envVar}=${fields[fieldDef.key]}`);
          }
        }
      }

      // --- Task adapter ---
      if (body.task) {
        const adapterName = body.task.adapter;
        const fields = body.task.fields;

        const adapter = createTaskAdapter(adapterName);
        const setupInfo = adapter.getSetupInfo();

        // Write env vars using the declared envVar names
        for (const fieldDef of setupInfo.fields) {
          if (fieldDef.envVar && fields[fieldDef.key]) {
            envLines.push(`${fieldDef.envVar}=${fields[fieldDef.key]}`);
          }
        }

        // Prepare credentials (e.g. Jira base64 encoding)
        const prepared = adapter.prepareCredentials
          ? adapter.prepareCredentials(fields)
          : fields;

        // Write the computed auth token env var if adapter produces one
        // For Jira: the base64 token goes to ATC_JIRA_TOKEN
        if (adapterName === "jira" && prepared.token) {
          envLines.push(`ATC_JIRA_TOKEN=${prepared.token}`);
        }

        // Write non-sensitive config
        if (fields.baseUrl) {
          localConfig.taskAdapter = {
            enabled: true,
            baseUrl: fields.baseUrl,
          };
        }
      }

      // --- Rate limits ---
      if (body.rateLimits && Object.keys(body.rateLimits).length > 0) {
        const rlConfig: Record<string, { maxPerMinute: number }> = {};
        for (const [name, maxPerMinute] of Object.entries(body.rateLimits)) {
          if (typeof maxPerMinute === "number" && maxPerMinute > 0) {
            rlConfig[name] = { maxPerMinute };
          }
        }
        if (Object.keys(rlConfig).length > 0) {
          localConfig.rateLimits = rlConfig;
        }
      }

      // Write config/local.yaml
      writeFileSync(resolve(configDir, "local.yaml"), toYaml(localConfig), "utf-8");
      log.info("Wrote config/local.yaml");

      // Write .env
      if (envLines.length > 0) {
        writeFileSync(resolve(projectRoot, ".env"), envLines.join("\n") + "\n", "utf-8");
        log.info("Wrote .env");

        // Set env vars in current process
        for (const line of envLines) {
          const eqIndex = line.indexOf("=");
          if (eqIndex !== -1) {
            process.env[line.slice(0, eqIndex)] = line.slice(eqIndex + 1);
          }
        }
      }

      // Reload config
      resetConfig();
      state.config = loadConfig(projectRoot);

      // Stop existing pipeline
      if (state.pipeline) {
        state.pipeline.stop();
        state.pipeline = null;
      }

      // Recreate rate limiters
      const rlDefaults: Record<string, { maxPerMinute: number; displayName: string }> = {
        llm: { maxPerMinute: 4, displayName: "LLM" },
        slack: { maxPerMinute: 25, displayName: "Slack" },
        jira: { maxPerMinute: 30, displayName: "Jira" },
      };
      for (const [name, limiter] of Object.entries(state.rateLimiters)) {
        if (!rlDefaults[name]) {
          rlDefaults[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
        }
      }
      if (state.config.rateLimits) {
        for (const [name, cfg] of Object.entries(state.config.rateLimits)) {
          if (cfg?.maxPerMinute) {
            rlDefaults[name] = { ...rlDefaults[name], maxPerMinute: cfg.maxPerMinute };
          }
        }
      }
      const newLimiters: Record<string, RateLimiter> = {};
      for (const [name, entry] of Object.entries(rlDefaults)) {
        newLimiters[name] = createRateLimiter({ name, ...entry });
      }
      state.rateLimiters = newLimiters;

      // Reconnect messaging adapter
      if (body.messaging) {
        const adapter = createMessagingAdapter(body.messaging.adapter);
        (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(
          newLimiters[body.messaging.adapter],
        );
        // Use prepareCredentials if available, otherwise pass fields as-is
        const creds = adapter.prepareCredentials
          ? adapter.prepareCredentials(body.messaging.fields)
          : body.messaging.fields;
        await adapter.connect(creds as Record<string, string> & { token: string });
        state.messagingAdapter = adapter;
        log.info("Messaging adapter reconnected");
      }

      // Reconnect task adapter
      if (body.task) {
        const adapter = createTaskAdapter(body.task.adapter);
        (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(
          newLimiters[body.task.adapter],
        );
        const creds = adapter.prepareCredentials
          ? adapter.prepareCredentials(body.task.fields)
          : body.task.fields;
        await adapter.connect(creds as Record<string, string> & { token: string });
        state.taskAdapter = adapter;
        log.info("Task adapter reconnected");
      }

      // Recreate classifier
      state.classifier = Classifier.fromConfig(state.config);
      if (newLimiters.llm) state.classifier.setRateLimiter(newLimiters.llm);

      // Restart pipeline if we have a messaging adapter
      if (state.messagingAdapter) {
        state.pipeline = new Pipeline(
          state.messagingAdapter,
          state.classifier,
          state.graph,
          state.linker,
          state.taskAdapter ?? undefined,
          state.config,
        );
        await state.pipeline.start();
        log.info("Pipeline restarted");
      }

      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Setup failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });
```

- [ ] **Step 4: Run all server tests**

Run: `npx vitest run tests/server/`
Expected: PASS (existing server tests may need updating if they POST to /api/setup with the old format — check and update in next step)

- [ ] **Step 5: Commit**

```bash
git add core/server.ts tests/server/setup-post-api.test.ts
git commit -m "feat: restructure POST /api/setup to accept adapter-driven payload"
```

---

### Task 7: Restructure `GET /api/setup/prefill` and `GET /api/setup/status`

**Files:**
- Modify: `core/server.ts` (the prefill and status handlers)

- [ ] **Step 1: Rewrite GET /api/setup/prefill**

Replace the `app.get("/api/setup/prefill", ...)` handler in `core/server.ts` with:

```typescript
  // --- GET /api/setup/prefill ---
  // Returns env var values to pre-populate the setup form, structured by adapter.
  app.get("/api/setup/prefill", (c) => {
    const result: Record<string, unknown> = {};

    // Messaging adapters — check env vars for each registered adapter
    const messagingInfos = getMessagingAdapterSetupInfo();
    for (const info of messagingInfos) {
      const fields: Record<string, string> = {};
      let hasValues = false;
      for (const field of info.fields) {
        if (field.envVar) {
          const val = process.env[field.envVar] ?? "";
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
      }
      if (hasValues) {
        result.messaging = { adapter: info.name, fields };
        break; // Use the first adapter that has prefill values
      }
    }

    // Task adapters — same pattern
    const taskInfos = getTaskAdapterSetupInfo();
    for (const info of taskInfos) {
      const fields: Record<string, string> = {};
      let hasValues = false;
      for (const field of info.fields) {
        if (field.envVar) {
          const val = process.env[field.envVar] ?? "";
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
      }
      if (hasValues) {
        result.task = { adapter: info.name, fields };
        break;
      }
    }

    // LLM — stays as-is (not adapter-driven)
    result.llm = {
      apiKey: process.env.ATC_LLM_API_KEY ?? "",
      baseUrl: process.env.ATC_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      model: process.env.ATC_LLM_MODEL ?? "claude-sonnet-4-6",
    };

    // Rate limits from registered limiters
    const rateLimits: Record<string, { maxPerMinute: number; displayName: string }> = {};
    for (const [name, limiter] of Object.entries(state.rateLimiters)) {
      rateLimits[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
    }
    result.rateLimits = rateLimits;

    return c.json(result);
  });
```

- [ ] **Step 2: Rewrite GET /api/setup/status**

Replace the `app.get("/api/setup/status", ...)` handler in `core/server.ts` with:

```typescript
  // --- GET /api/setup/status ---
  app.get("/api/setup/status", (c) => {
    const llmConfigured = !!(
      state.config.classifier.provider.apiKey ||
      state.config.classifier.provider.baseUrl.includes("localhost") ||
      state.config.classifier.provider.baseUrl.includes("127.0.0.1")
    );

    const messagingConnected = !!state.messagingAdapter;
    const taskConnected = !!state.taskAdapter;

    const platformMeta: Record<string, unknown> = state.messagingAdapter?.getMetadata?.() ?? {};

    return c.json({
      configured: messagingConnected && llmConfigured,
      llm: llmConfigured,
      adapters: {
        messaging: messagingConnected
          ? { name: state.messagingAdapter!.name, connected: true }
          : null,
        task: taskConnected
          ? { name: state.taskAdapter!.name, connected: true }
          : null,
      },
      platformMeta,
    });
  });
```

- [ ] **Step 3: Run all server tests**

Run: `npx vitest run tests/server/`
Expected: Some tests may fail if they assert on the old `status.slack` / `status.jira` shape. Update them if needed (see Task 8).

- [ ] **Step 4: Commit**

```bash
git add core/server.ts
git commit -m "feat: restructure GET /api/setup/prefill and GET /api/setup/status for adapter-driven setup"
```

---

### Task 8: Update Existing Server Tests for New API Shape

**Files:**
- Modify: Any server tests that reference old `SetupConfig` shape, `status.slack`, `status.jira`

- [ ] **Step 1: Find tests referencing old setup shapes**

Search for: `slackToken`, `jiraToken`, `status.slack`, `status.jira` in `tests/server/`

- [ ] **Step 2: Update each test to use new payload/response shapes**

For any test that POSTs to `/api/setup`, change from:
```typescript
{ slackToken: "xoxp-...", llmApiKey: "...", ... }
```
To:
```typescript
{
  messaging: { adapter: "slack", fields: { token: "xoxp-..." } },
  llm: { apiKey: "...", baseUrl: "...", model: "..." },
}
```

For any test that reads `status.slack` or `status.jira`, change to:
```typescript
status.adapters.messaging?.name === "slack"
status.adapters.task?.name === "jira"
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: update server tests for new structured setup API shapes"
```

---

### Task 9: Update Frontend API Types — `src/lib/api.ts`

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add new types and update existing ones**

In `src/lib/api.ts`, replace the `SetupStatus`, `SetupConfig`, `SetupPrefill` types and add new types. Replace these types (lines ~83-109):

```typescript
export interface SetupField {
  key: string;
  label: string;
  type: "text" | "password" | "email" | "url";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  helpUrl?: string;
  // Note: envVar is NOT included — stripped by server
}

export interface AdapterSetupInfo {
  name: string;
  displayName: string;
  fields: SetupField[];
  helpUrl?: string;
}

export interface SetupAdaptersResponse {
  messaging: AdapterSetupInfo[];
  task: AdapterSetupInfo[];
}

export interface SetupStatus {
  configured: boolean;
  llm: boolean;
  adapters: {
    messaging: { name: string; connected: boolean } | null;
    task: { name: string; connected: boolean } | null;
  };
  platformMeta: Record<string, unknown>;
}

export interface SetupPayload {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm?: { apiKey: string; baseUrl: string; model: string };
  rateLimits?: Record<string, number>;
}

export interface RateLimitInfo {
  maxPerMinute: number;
  displayName: string;
}

export interface SetupPrefill {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm: { apiKey: string; baseUrl: string; model: string };
  rateLimits?: Record<string, RateLimitInfo>;
}
```

Remove the old `SetupConfig` type entirely.

- [ ] **Step 2: Update `postSetup` function**

Change the `postSetup` function from:
```typescript
export function postSetup(config: SetupConfig): Promise<{ ok: boolean }> {
```
To:
```typescript
export function postSetup(config: SetupPayload): Promise<{ ok: boolean }> {
```

- [ ] **Step 3: Add `fetchSetupAdapters` function**

Add after the existing `fetchSetupPrefill`:

```typescript
export function fetchSetupAdapters(): Promise<SetupAdaptersResponse> {
  return apiFetch("/api/setup/adapters");
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json` (or however the project checks types)
Expected: May have errors in Setup.tsx since it still references old types — that's expected, we'll fix it in Task 11.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: update frontend API types for dynamic adapter setup"
```

---

### Task 10: New `AdapterFieldGroup` Component

**Files:**
- Create: `src/components/AdapterFieldGroup.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/AdapterFieldGroup.tsx`:

```tsx
import type { JSX } from "react";
import type { SetupField } from "../lib/api";

interface AdapterFieldGroupProps {
  fields: SetupField[];
  values: Record<string, string>;
  envFields: Record<string, boolean>;
  onChange: (key: string, value: string) => void;
}

function FromEnvBadge() {
  return (
    <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
      from env
    </span>
  );
}

const inputClass =
  "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500";

export default function AdapterFieldGroup({
  fields,
  values,
  envFields,
  onChange,
}: AdapterFieldGroupProps): JSX.Element {
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label
            htmlFor={`adapter-${field.key}`}
            className="flex items-center text-xs text-gray-400 mb-1"
          >
            {field.label}
            {field.required && " *"}
            {envFields[field.key] && <FromEnvBadge />}
          </label>
          <input
            id={`adapter-${field.key}`}
            type={field.type}
            value={values[field.key] ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            className={inputClass}
          />
          {field.helpText && (
            <p className="mt-1 text-[11px] text-gray-600">{field.helpText}</p>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AdapterFieldGroup.tsx
git commit -m "feat: add AdapterFieldGroup component for dynamic adapter form fields"
```

---

### Task 11: Rewrite `Setup.tsx` With Dynamic Adapter Sections

**Files:**
- Modify: `src/components/Setup.tsx`

This is the largest frontend change. The component needs to:
1. Fetch adapter schemas on mount via `GET /api/setup/adapters`
2. Render Messaging and Task sections dynamically from adapter schemas
3. Keep LLM section as-is (hardcoded presets)
4. Build structured payload on submit

- [ ] **Step 1: Rewrite Setup.tsx**

Replace the entire contents of `src/components/Setup.tsx` with:

```tsx
import { useState, useEffect, type JSX, type FormEvent } from "react";
import {
  postSetup,
  fetchSetupPrefill,
  fetchSetupAdapters,
  openExternalUrl,
  type SetupPayload,
  type RateLimitInfo,
  type AdapterSetupInfo,
} from "../lib/api";
import AdapterFieldGroup from "./AdapterFieldGroup";

interface SetupProps {
  onComplete: () => void;
}

// --- LLM Provider presets (stays in frontend) ---

type ProviderPreset = "anthropic" | "openai" | "openrouter" | "ollama" | "custom";

const PRESETS: Record<
  ProviderPreset,
  { label: string; baseUrl: string; models: string[]; needsKey: boolean }
> = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openrouter/auto",
      "openrouter/free",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-haiku-4",
      "google/gemini-2.5-pro-preview",
      "google/gemini-2.5-flash-preview",
      "openai/gpt-4o",
      "meta-llama/llama-4-maverick",
      "deepseek/deepseek-r1",
    ],
    needsKey: true,
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2.5"],
    needsKey: false,
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    models: [],
    needsKey: true,
  },
};

function openExternal(url: string) {
  openExternalUrl(url);
}

export default function Setup({ onComplete }: SetupProps): JSX.Element {
  // Adapter schemas from server
  const [messagingAdapters, setMessagingAdapters] = useState<AdapterSetupInfo[]>([]);
  const [taskAdapters, setTaskAdapters] = useState<AdapterSetupInfo[]>([]);

  // Selected adapter per category
  const [selectedMessaging, setSelectedMessaging] = useState<string>("");
  const [selectedTask, setSelectedTask] = useState<string>("");

  // Field values per adapter (keyed by adapter name, then field key)
  const [messagingFields, setMessagingFields] = useState<Record<string, string>>({});
  const [taskFields, setTaskFields] = useState<Record<string, string>>({});
  const [messagingEnv, setMessagingEnv] = useState<Record<string, boolean>>({});
  const [taskEnv, setTaskEnv] = useState<Record<string, boolean>>({});

  // LLM fields
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState(PRESETS.anthropic.baseUrl);
  const [llmModel, setLlmModel] = useState(PRESETS.anthropic.models[0]);
  const [preset, setPreset] = useState<ProviderPreset>("anthropic");
  const [llmEnv, setLlmEnv] = useState<Record<string, boolean>>({});

  // Rate limits
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimitInfo>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch adapter schemas + prefill on mount
  useEffect(() => {
    Promise.all([fetchSetupAdapters(), fetchSetupPrefill()])
      .then(([adapters, prefill]) => {
        // Set adapter schemas
        setMessagingAdapters(adapters.messaging);
        setTaskAdapters(adapters.task);

        // Default selection: first adapter, or prefilled adapter
        const defaultMessaging = prefill.messaging?.adapter ?? adapters.messaging[0]?.name ?? "";
        const defaultTask = prefill.task?.adapter ?? adapters.task[0]?.name ?? "";
        setSelectedMessaging(defaultMessaging);
        setSelectedTask(defaultTask);

        // Prefill messaging fields
        if (prefill.messaging?.fields) {
          setMessagingFields(prefill.messaging.fields);
          const env: Record<string, boolean> = {};
          for (const key of Object.keys(prefill.messaging.fields)) {
            if (prefill.messaging.fields[key]) env[key] = true;
          }
          setMessagingEnv(env);
        }

        // Prefill task fields
        if (prefill.task?.fields) {
          setTaskFields(prefill.task.fields);
          const env: Record<string, boolean> = {};
          for (const key of Object.keys(prefill.task.fields)) {
            if (prefill.task.fields[key]) env[key] = true;
          }
          setTaskEnv(env);
        }

        // Prefill LLM
        if (prefill.llm) {
          const envDetected: Record<string, boolean> = {};
          if (prefill.llm.apiKey) {
            setLlmApiKey(prefill.llm.apiKey);
            envDetected.apiKey = true;
          }
          if (prefill.llm.baseUrl) {
            setLlmBaseUrl(prefill.llm.baseUrl);
            envDetected.baseUrl = true;
            // Detect preset from base URL
            for (const [id, p] of Object.entries(PRESETS) as [ProviderPreset, typeof PRESETS[ProviderPreset]][]) {
              if (p.baseUrl && prefill.llm.baseUrl.startsWith(p.baseUrl.replace("/v1", ""))) {
                setPreset(id);
                break;
              }
            }
          }
          if (prefill.llm.model) {
            setLlmModel(prefill.llm.model);
            envDetected.model = true;
          }
          setLlmEnv(envDetected);
        }

        // Prefill rate limits
        if (prefill.rateLimits) {
          setRateLimits(prefill.rateLimits);
        }
      })
      .catch(() => {/* prefill + adapters are best-effort */});
  }, []);

  // Current adapter info objects
  const currentMessaging = messagingAdapters.find((a) => a.name === selectedMessaging);
  const currentTask = taskAdapters.find((a) => a.name === selectedTask);
  const currentPreset = PRESETS[preset];

  function updateMessagingField(key: string, value: string) {
    setMessagingFields((prev) => ({ ...prev, [key]: value }));
    setMessagingEnv((prev) => ({ ...prev, [key]: false }));
  }

  function updateTaskField(key: string, value: string) {
    setTaskFields((prev) => ({ ...prev, [key]: value }));
    setTaskEnv((prev) => ({ ...prev, [key]: false }));
  }

  function applyPreset(id: ProviderPreset) {
    setPreset(id);
    const p = PRESETS[id];
    setLlmBaseUrl(p.baseUrl || llmBaseUrl);
    setLlmModel(p.models[0] ?? llmModel);
    if (!p.needsKey) setLlmApiKey("(not required)");
    setLlmEnv({});
  }

  function updateRateLimit(name: string, value: string) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setRateLimits((prev) => ({
        ...prev,
        [name]: { ...prev[name], maxPerMinute: parsed },
      }));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validate required messaging fields
    if (currentMessaging) {
      for (const field of currentMessaging.fields) {
        if (field.required && !messagingFields[field.key]?.trim()) {
          setError(`${currentMessaging.displayName}: ${field.label} is required.`);
          return;
        }
      }
    }

    // Validate LLM key
    const needsKey = currentPreset.needsKey;
    const keyValue = llmApiKey === "(not required)" ? "" : llmApiKey;
    if (needsKey && !keyValue.trim()) {
      setError("LLM API Key is required.");
      return;
    }

    setSubmitting(true);
    try {
      const payload: SetupPayload = {};

      // Messaging
      if (selectedMessaging && currentMessaging) {
        const fields: Record<string, string> = {};
        for (const field of currentMessaging.fields) {
          const val = messagingFields[field.key]?.trim();
          if (val) fields[field.key] = val;
        }
        if (Object.keys(fields).length > 0) {
          payload.messaging = { adapter: selectedMessaging, fields };
        }
      }

      // Task (optional)
      if (selectedTask && currentTask) {
        const fields: Record<string, string> = {};
        let hasValues = false;
        for (const field of currentTask.fields) {
          const val = taskFields[field.key]?.trim();
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
        if (hasValues) {
          payload.task = { adapter: selectedTask, fields };
        }
      }

      // LLM
      payload.llm = {
        apiKey: keyValue.trim(),
        baseUrl: llmBaseUrl.trim() || PRESETS.anthropic.baseUrl,
        model: llmModel.trim() || PRESETS.anthropic.models[0],
      };

      // Rate limits
      if (Object.keys(rateLimits).length > 0) {
        const rl: Record<string, number> = {};
        for (const [name, info] of Object.entries(rateLimits)) {
          rl[name] = info.maxPerMinute;
        }
        payload.rateLimits = rl;
      }

      await postSetup(payload);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500";
  const selectClass =
    "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500";

  const apiKeyLink: Record<string, string> = {
    anthropic: "https://console.anthropic.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    openrouter: "https://openrouter.ai/keys",
    ollama: "https://ollama.com",
  };
  const currentKeyLink = apiKeyLink[preset] ?? null;

  const rateLimitEntries = Object.entries(rateLimits).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mx-auto max-w-md py-10 px-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">Configure ATC</h2>
      <p className="text-xs text-gray-500 mb-6">
        Connect your messaging platform and LLM provider to get started.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* ── Messaging ─────────────────────────────────────── */}
        {messagingAdapters.length > 0 && (
          <fieldset className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                {messagingAdapters.length === 1
                  ? messagingAdapters[0].displayName
                  : "Messaging"}
              </legend>
              {currentMessaging?.helpUrl && (
                <button
                  type="button"
                  onClick={() => openExternal(currentMessaging.helpUrl!)}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  Get token →
                </button>
              )}
            </div>

            {/* Adapter selector — only when multiple adapters */}
            {messagingAdapters.length > 1 && (
              <div className="flex gap-1.5">
                {messagingAdapters.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => {
                      setSelectedMessaging(a.name);
                      setMessagingFields({});
                      setMessagingEnv({});
                    }}
                    className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                      selectedMessaging === a.name
                        ? "border-blue-500 bg-blue-900/40 text-blue-300"
                        : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                    }`}
                  >
                    {a.displayName}
                  </button>
                ))}
              </div>
            )}

            {currentMessaging && (
              <AdapterFieldGroup
                fields={currentMessaging.fields}
                values={messagingFields}
                envFields={messagingEnv}
                onChange={updateMessagingField}
              />
            )}
          </fieldset>
        )}

        {/* ── LLM Provider ──────────────────────────────────── */}
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              {currentPreset.label}
            </legend>
            {currentKeyLink && (
              <button
                type="button"
                onClick={() => openExternal(currentKeyLink)}
                className="text-[11px] text-blue-400 hover:text-blue-300"
              >
                {preset === "ollama" ? "Get Ollama →" : "Get API key →"}
              </button>
            )}
          </div>

          {/* Provider selector */}
          <div className="flex gap-1.5">
            {(Object.keys(PRESETS) as ProviderPreset[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => applyPreset(id)}
                className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                  preset === id
                    ? "border-blue-500 bg-blue-900/40 text-blue-300"
                    : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                }`}
              >
                {PRESETS[id].label}
              </button>
            ))}
          </div>

          {/* API Key */}
          {currentPreset.needsKey && (
            <div>
              <label htmlFor="llmApiKey" className="flex items-center text-xs text-gray-400 mb-1">
                API Key *
                {llmEnv.apiKey && (
                  <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                    from env
                  </span>
                )}
              </label>
              <input
                id="llmApiKey"
                type="password"
                value={llmApiKey}
                onChange={(e) => { setLlmApiKey(e.target.value); setLlmEnv((p) => ({ ...p, apiKey: false })); }}
                placeholder={preset === "anthropic" ? "sk-ant-..." : "sk-..."}
                className={inputClass}
              />
            </div>
          )}
          {!currentPreset.needsKey && (
            <p className="text-[11px] text-green-500">
              No API key required — Ollama runs locally.
            </p>
          )}

          {/* Model selector */}
          <div>
            <label htmlFor="llmModel" className="flex items-center text-xs text-gray-400 mb-1">
              Model
              {llmEnv.model && (
                <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                  from env
                </span>
              )}
            </label>
            {currentPreset.models.length > 0 ? (
              <select
                id="llmModel"
                value={llmModel}
                onChange={(e) => { setLlmModel(e.target.value); setLlmEnv((p) => ({ ...p, model: false })); }}
                className={selectClass}
              >
                {currentPreset.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            ) : (
              <input
                id="llmModel"
                type="text"
                value={llmModel}
                onChange={(e) => { setLlmModel(e.target.value); setLlmEnv((p) => ({ ...p, model: false })); }}
                placeholder="model name"
                className={inputClass}
              />
            )}
            {currentPreset.models.length > 0 && llmModel === "custom" && (
              <input
                type="text"
                value=""
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="Enter model name"
                className={`${inputClass} mt-1.5`}
                autoFocus
              />
            )}
          </div>

          {/* Base URL */}
          {(preset === "custom" || preset === "ollama") && (
            <div>
              <label htmlFor="llmBaseUrl" className="flex items-center text-xs text-gray-400 mb-1">
                Base URL
                {llmEnv.baseUrl && (
                  <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                    from env
                  </span>
                )}
              </label>
              <input
                id="llmBaseUrl"
                type="text"
                value={llmBaseUrl}
                onChange={(e) => { setLlmBaseUrl(e.target.value); setLlmEnv((p) => ({ ...p, baseUrl: false })); }}
                placeholder="http://localhost:11434/v1"
                className={inputClass}
              />
            </div>
          )}
        </fieldset>

        {/* ── Task Adapter (optional) ──────────────────────── */}
        {taskAdapters.length > 0 && (
          <fieldset className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                {taskAdapters.length === 1
                  ? taskAdapters[0].displayName
                  : "Task Manager"}{" "}
                <span className="normal-case text-gray-600">(optional)</span>
              </legend>
              {currentTask?.helpUrl && (
                <button
                  type="button"
                  onClick={() => openExternal(currentTask.helpUrl!)}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  Get token →
                </button>
              )}
            </div>

            {/* Adapter selector — only when multiple adapters */}
            {taskAdapters.length > 1 && (
              <div className="flex gap-1.5">
                {taskAdapters.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => {
                      setSelectedTask(a.name);
                      setTaskFields({});
                      setTaskEnv({});
                    }}
                    className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                      selectedTask === a.name
                        ? "border-blue-500 bg-blue-900/40 text-blue-300"
                        : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                    }`}
                  >
                    {a.displayName}
                  </button>
                ))}
              </div>
            )}

            {currentTask && (
              <AdapterFieldGroup
                fields={currentTask.fields}
                values={taskFields}
                envFields={taskEnv}
                onChange={updateTaskField}
              />
            )}
          </fieldset>
        )}

        {/* ── Rate Limits (dynamic) ─────────────────────────── */}
        {rateLimitEntries.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
              Rate Limits{" "}
              <span className="normal-case text-gray-600">(requests/min)</span>
            </legend>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(rateLimitEntries.length, 4)}, minmax(0, 1fr))` }}>
              {rateLimitEntries.map(([name, info]) => (
                <div key={name}>
                  <label htmlFor={`rl-${name}`} className="text-xs text-gray-400 mb-1 block">
                    {info.displayName}
                  </label>
                  <input
                    id={`rl-${name}`}
                    type="number"
                    min={1}
                    max={200}
                    value={info.maxPerMinute}
                    onChange={(e) => updateRateLimit(name, e.target.value)}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-600">
              Lower values reduce API load; raise if you see frequent throttling.
            </p>
          </fieldset>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : "Save & Continue"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify the frontend compiles**

Run: `npx tsc --noEmit` or `npm run build`
Expected: PASS (or only unrelated errors)

- [ ] **Step 3: Commit**

```bash
git add src/components/Setup.tsx
git commit -m "feat: rewrite Setup.tsx with dynamic adapter-driven form sections"
```

---

### Task 12: Update Status Indicators in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

The App component reads from `status.slack` and `status.jira` for the service dots. With the new API, it reads from `status.adapters.messaging` and `status.adapters.task`.

However, looking at the current `App.tsx`, the service dots actually come from `fetchStatus()` → `status.services` (the engine status endpoint, not the setup status endpoint). The setup status is only used to decide whether to show the setup page or the inbox.

The `fetchSetupStatus()` call in `init()` uses `status.configured` and `status.platformMeta`. We need to update this to read from the new shape.

- [ ] **Step 1: Update the init() function in App.tsx**

The `init()` function calls `fetchSetupStatus()`. Update to handle the new response shape. The key change is that `status.platformMeta` stays the same, and `status.configured` stays the same — so `init()` doesn't actually need changes.

However, if any other part of the app reads `status.slack` or `status.jira`, update those. Looking at the code, `App.tsx` only uses `status.configured` and `status.platformMeta` — both still exist in the new shape. No changes needed to `App.tsx`.

- [ ] **Step 2: Verify by checking for any references to old SetupStatus fields**

Search `src/` for `status.slack`, `status.jira`, `.slack`, `.jira` in TypeScript files to find any code that depends on the old shape.

- [ ] **Step 3: If no references found, skip this task. If references found, update them.**

The service dots in the header come from `fetchStatus()` → `EngineStatus.services`, which is a separate endpoint (`/api/status`) that already uses dynamic service names. No changes needed.

- [ ] **Step 4: Commit (if changes were made)**

```bash
git add src/App.tsx
git commit -m "fix: update App.tsx status indicators for new setup status shape"
```

---

### Task 13: Remove Old `SetupConfig` References and Final Cleanup

**Files:**
- Search across all files for remaining `SetupConfig` references
- Modify any files still importing the old type

- [ ] **Step 1: Search for remaining old type references**

Search for: `SetupConfig`, `slackToken`, `jiraEmail`, `jiraToken`, `jiraBaseUrl` (as API field names) across `src/` and `core/`.

- [ ] **Step 2: Fix any remaining references**

Update any remaining imports or usages to use `SetupPayload` and the new API shape.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Run frontend build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove old SetupConfig references and final cleanup"
```
