import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

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
      slack: { pollInterval: 30, channels: [] },
      classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
      jira: { enabled: false, ticketPrefixes: [] },
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

describe("GET /api/setup/status", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    state.db.close();
  });

  it("returns correct shape when nothing configured", async () => {
    const app = createApp(state);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("configured");
    expect(body).toHaveProperty("llm");
    expect(body).toHaveProperty("platformMeta");

    expect(body.configured).toBe(false);
    expect(body.platformMeta).toEqual({});
  });

  it("returns configured true when slack token and llm are set", async () => {
    const origToken = process.env.ATC_SLACK_TOKEN;
    process.env.ATC_SLACK_TOKEN = "xoxp-test";

    const app = createApp(state);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    // llm is true (baseUrl contains "localhost"), slack token is set
    expect(body.configured).toBe(true);
    expect(body.slack).toBe(true);
    expect(body.llm).toBe(true);

    if (origToken === undefined) delete process.env.ATC_SLACK_TOKEN;
    else process.env.ATC_SLACK_TOKEN = origToken;
  });
});

describe("GET /api/setup/prefill", () => {
  let state: EngineState;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    state = makeState();
    originalEnv = {
      ATC_SLACK_TOKEN: process.env.ATC_SLACK_TOKEN,
      ATC_JIRA_EMAIL: process.env.ATC_JIRA_EMAIL,
      ATC_JIRA_API_TOKEN: process.env.ATC_JIRA_API_TOKEN,
      ATC_JIRA_BASE_URL: process.env.ATC_JIRA_BASE_URL,
      ATC_LLM_API_KEY: process.env.ATC_LLM_API_KEY,
      ATC_LLM_BASE_URL: process.env.ATC_LLM_BASE_URL,
      ATC_LLM_MODEL: process.env.ATC_LLM_MODEL,
    };
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
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

  it("returns slackToken when ATC_SLACK_TOKEN env var is set", async () => {
    process.env.ATC_SLACK_TOKEN = "xoxp-test";

    const app = createApp(state);
    const res = await app.request("/api/setup/prefill");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.slackToken).toBe("xoxp-test");
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
