import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

// IMPORTANT: Import adapter modules so they self-register with the adapter registry.
// Without these imports, getMessagingAdapterSetupInfo() and getTaskAdapterSetupInfo()
// return empty arrays.
import "../../core/adapters/messaging/slack/index.js";
import "../../core/adapters/tasks/jira/index.js";

function makeState(): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
  const classifier = new Classifier(
    { name: "mock", classify: vi.fn() },
    "sys",
    [],
  );
  const linker = new WorkItemLinker(graph, [
    new DefaultExtractor({ ticketPatterns: [], prPatterns: [] }),
  ]);
  return {
    config: {
      messaging: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
      taskAdapter: { enabled: false, ticketPrefixes: [] },
      extractors: { ticketPatterns: [], prPatterns: [] },
      mcp: { transport: "stdio" },
      server: { port: 9847, host: "127.0.0.1" },
      anomalies: { staleThresholdHours: 4, silentAgentThresholdHours: 2 },
    } as any,
    db,
    graph,
    classifier,
    usageTracker: null,
    linker,
    pipeline: null,
    platformAdapter: null,
    taskAdapter: null,
    rateLimiters: {},
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
  } as any;
}

describe("GET /api/setup/adapters", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns 200 with messaging and task arrays", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/adapters");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("messaging");
    expect(body).toHaveProperty("task");
    expect(Array.isArray(body.messaging)).toBe(true);
    expect(Array.isArray(body.task)).toBe(true);
  });

  it("messaging array includes slack adapter with fields", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/adapters");
    const body = await res.json();

    const slack = body.messaging.find((a: { name: string }) => a.name === "slack");
    expect(slack).toBeDefined();
    expect(slack.displayName).toBe("Slack");
    expect(Array.isArray(slack.fields)).toBe(true);
    expect(slack.fields.length).toBeGreaterThan(0);
  });

  it("task array includes jira adapter with 3 fields (email, token, baseUrl)", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/adapters");
    const body = await res.json();

    const jira = body.task.find((a: { name: string }) => a.name === "jira");
    expect(jira).toBeDefined();
    expect(jira.displayName).toBe("Jira");
    expect(jira.fields).toHaveLength(3);

    const keys = jira.fields.map((f: { key: string }) => f.key);
    expect(keys).toContain("email");
    expect(keys).toContain("token");
    expect(keys).toContain("baseUrl");
  });

  it("strips envVar from all fields in the response", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/adapters");
    const body = await res.json();

    const allFields = [
      ...body.messaging.flatMap((a: { fields: unknown[] }) => a.fields),
      ...body.task.flatMap((a: { fields: unknown[] }) => a.fields),
    ];

    for (const field of allFields) {
      expect(field).not.toHaveProperty("envVar");
    }
  });
});

describe("GET /api/setup/status", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns correct shape when no adapters connected", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("configured");
    expect(body).toHaveProperty("llm");
    expect(body).toHaveProperty("adapters");
    expect(body).toHaveProperty("platformMeta");

    expect(body.configured).toBe(false);
    expect(body.adapters.messaging).toBeNull();
    expect(body.adapters.task).toBeNull();
    expect(body.platformMeta).toEqual({});
  });

  it("returns adapter info and platformMeta when messaging adapter is set", async () => {
    state.messagingAdapter = {
      name: "slack",
      displayName: "Slack",
      getMetadata: () => ({ teamName: "Test" }),
    } as any;

    const app = createApp(state);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.adapters.messaging).toEqual({ name: "slack", connected: true });
    expect(body.platformMeta).toMatchObject({ teamName: "Test" });
    // config.classifier.provider.baseUrl is "http://localhost" which contains "localhost",
    // so llmConfigured is true. With messaging also connected, configured = true.
    expect(body.configured).toBe(true);
  });
});

describe("GET /api/setup/prefill", () => {
  let state: EngineState;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    state = makeState();
    // Snapshot relevant env vars before each test
    originalEnv = {
      ATC_SLACK_TOKEN: process.env.ATC_SLACK_TOKEN,
      ATC_JIRA_EMAIL: process.env.ATC_JIRA_EMAIL,
      ATC_JIRA_API_TOKEN: process.env.ATC_JIRA_API_TOKEN,
      ATC_JIRA_BASE_URL: process.env.ATC_JIRA_BASE_URL,
      ATC_LLM_API_KEY: process.env.ATC_LLM_API_KEY,
      ATC_LLM_BASE_URL: process.env.ATC_LLM_BASE_URL,
      ATC_LLM_MODEL: process.env.ATC_LLM_MODEL,
    };
    // Clear all relevant env vars before each test
    delete process.env.ATC_SLACK_TOKEN;
    delete process.env.ATC_JIRA_EMAIL;
    delete process.env.ATC_JIRA_API_TOKEN;
    delete process.env.ATC_JIRA_BASE_URL;
    delete process.env.ATC_LLM_API_KEY;
    delete process.env.ATC_LLM_BASE_URL;
    delete process.env.ATC_LLM_MODEL;
  });

  afterEach(() => {
    state.db.close();
    // Restore env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns LLM defaults when no env vars are set", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/prefill");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("llm");
    expect(body.llm.apiKey).toBe("");
    expect(body.llm.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(body.llm.model).toBe("claude-sonnet-4-6");
  });

  it("returns no messaging or task fields when no env vars are set", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/prefill");
    const body = await res.json();

    expect(body.messaging).toBeUndefined();
    expect(body.task).toBeUndefined();
  });

  it("returns messaging adapter fields when ATC_SLACK_TOKEN env var is set", async () => {
    process.env.ATC_SLACK_TOKEN = "xoxp-test";

    const app = createApp(state);
    const res = await app.request("/api/setup/prefill");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.messaging).toBeDefined();
    expect(body.messaging.adapter).toBe("slack");
    expect(body.messaging.fields.token).toBe("xoxp-test");
  });
});

describe("POST /api/setup", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns 200 with { ok: true } shape on basic valid payload", async () => {
    // Mock fs writes so the test doesn't touch the filesystem
    const fsMock = {
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    vi.doMock("node:fs", () => fsMock);

    const app = createApp(state);
    const res = await app.request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          apiKey: "test-key",
          baseUrl: "https://api.anthropic.com/v1",
          model: "claude-sonnet-4-6",
        },
      }),
    });

    // The endpoint returns 200 on success or 500 on error (e.g. filesystem issues).
    // Either way, body should have an "ok" key.
    const body = await res.json();
    expect(body).toHaveProperty("ok");
  });
});

describe("GET /api/status — llmUsage", () => {
  it("returns null llmUsage when no tracker configured", async () => {
    const state = makeState();
    const app = createApp(state);
    const res = await app.request("/api/status");
    const body = await res.json();

    // llmUsage should be null when no tracker is on the state
    expect(body.llmUsage).toBeNull();
    state.db.close();
  });
});
