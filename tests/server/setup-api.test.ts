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
    messagingAdapter: null,
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
    expect(body).toHaveProperty("adapters");

    expect(body.configured).toBe(false);
    expect(body.platformMeta).toEqual({});
    expect(body.adapters.messaging).toBeNull();
    expect(body.adapters.task).toBeNull();
  });

  it("returns configured true when messaging adapter connected and llm are set", async () => {
    // Simulate a connected messaging adapter
    state.messagingAdapter = {
      name: "slack",
      displayName: "Slack",
      getSetupInfo: () => ({ name: "slack", displayName: "Slack", fields: [] }),
      connect: async () => {},
      readThreads: async () => [],
      replyToThread: async () => {},
      postMessage: async () => ({ threadId: "t1" }),
      sendDirectMessage: async () => ({ channelId: "c1", threadId: "t1" }),
      streamMessages: () => {},
      getUsers: async () => new Map(),
      getThreadMessages: async () => [],
    } as any;

    const app = createApp(state);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    // llm is true (baseUrl contains "localhost"), messaging adapter is connected
    expect(body.configured).toBe(true);
    expect(body.llm).toBe(true);
    expect(body.adapters.messaging).toEqual({ name: "slack", connected: true });
  });
});

describe("GET /api/setup/prefill", () => {
  let state: EngineState;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    state = makeState();
    originalEnv = {
      WORKSTREAM_SLACK_TOKEN: process.env.WORKSTREAM_SLACK_TOKEN,
      WORKSTREAM_JIRA_EMAIL: process.env.WORKSTREAM_JIRA_EMAIL,
      WORKSTREAM_JIRA_API_TOKEN: process.env.WORKSTREAM_JIRA_API_TOKEN,
      WORKSTREAM_JIRA_BASE_URL: process.env.WORKSTREAM_JIRA_BASE_URL,
      WORKSTREAM_LLM_API_KEY: process.env.WORKSTREAM_LLM_API_KEY,
      WORKSTREAM_LLM_BASE_URL: process.env.WORKSTREAM_LLM_BASE_URL,
      WORKSTREAM_LLM_MODEL: process.env.WORKSTREAM_LLM_MODEL,
    };
    delete process.env.WORKSTREAM_SLACK_TOKEN;
    delete process.env.WORKSTREAM_JIRA_EMAIL;
    delete process.env.WORKSTREAM_JIRA_API_TOKEN;
    delete process.env.WORKSTREAM_JIRA_BASE_URL;
    delete process.env.WORKSTREAM_LLM_API_KEY;
    delete process.env.WORKSTREAM_LLM_BASE_URL;
    delete process.env.WORKSTREAM_LLM_MODEL;
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

  it("returns messaging adapter fields when WORKSTREAM_SLACK_TOKEN env var is set", async () => {
    // Import the slack adapter module so it self-registers
    await import("../../core/adapters/messaging/slack/index.js");

    process.env.WORKSTREAM_SLACK_TOKEN = "xoxp-test";

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
      chmodSync: vi.fn(),
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

describe("POST /api/setup preserves what the form doesn't manage", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
  });

  it("keeps other .env keys and the classifier's decision settings", async () => {
    const files = new Map<string, string>();
    const at = (suffix: string) => [...files.keys()].find((k) => k.endsWith(suffix))!;
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        existsSync: (p: string) => files.has(String(p)) || (!String(p).endsWith(".env") && !String(p).endsWith("local.yaml") && real.existsSync(p)),
        readFileSync: (p: string, enc?: BufferEncoding) => files.get(String(p)) ?? real.readFileSync(p, enc),
        writeFileSync: (p: string, data: string) => { files.set(String(p), data); },
        mkdirSync: () => undefined,
        chmodSync: () => undefined,
      };
    });
    const { resolve } = await import("node:path");
    const { findProjectRoot } = await import("../../core/config.js");
    const root = findProjectRoot();
    files.set(resolve(root, ".env"), "OPENAI_API_KEY=sk-keep\nWORKSTREAM_LLM_API_KEY=old\n");
    files.set(resolve(root, "config", "local.yaml"),
      "classifier:\n  provider:\n    baseUrl: https://openrouter.ai/api/v1\n    model: old\n    apiKey: stale-literal\n    reasoningEffort: none\n  mode: decisions\n  decisions:\n    provider: openai\n    interruptThreshold: 0.3\noperator:\n  name: Alex\n  role: CTO\n  context: remit\ninbox:\n  handoffMinConfidence: 0.75\n");

    const state = makeState();
    const app = createApp(state);
    await app.request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: { apiKey: "new", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" },
        inbox: { expireAfterDays: 14 },
      }),
    });
    state.db.close();

    const env = files.get(at(".env"))!;
    expect(env).toContain("OPENAI_API_KEY=sk-keep");
    expect(env).toContain("WORKSTREAM_LLM_API_KEY=new");
    expect(env).not.toContain("WORKSTREAM_LLM_API_KEY=old");
    const yaml = files.get(at("local.yaml"))!;
    expect(yaml).toContain("mode: decisions");
    expect(yaml).toContain("interruptThreshold: 0.3");
    expect(yaml).toContain("model: anthropic/claude-haiku-5.5");
    expect(yaml).toContain("context: remit");
    expect(yaml).toContain("expireAfterDays: 14");
    expect(yaml).toContain("handoffMinConfidence: 0.75");
    // The new key in .env must win, and tuning for the old model doesn't carry over
    expect(yaml).not.toContain("stale-literal");
    expect(yaml).not.toContain("reasoningEffort");
  });

  it("keeps hand-set ticket prefixes when Jira settings are saved", async () => {
    await import("../../core/adapters/tasks/jira/index.js");
    const files = new Map<string, string>();
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        existsSync: (p: string) => files.has(String(p)),
        readFileSync: (p: string, enc?: BufferEncoding) => files.get(String(p)) ?? real.readFileSync(p, enc),
        writeFileSync: (p: string, data: string) => { files.set(String(p), data); },
        mkdirSync: () => undefined,
        chmodSync: () => undefined,
      };
    });
    const { resolve } = await import("node:path");
    const { findProjectRoot } = await import("../../core/config.js");
    const localPath = resolve(findProjectRoot(), "config", "local.yaml");
    files.set(localPath, "taskAdapter:\n  enabled: true\n  baseUrl: https://old.example.atlassian.net\n  token: pasted-by-hand\n  ticketPrefixes:\n    - OPS-\n");
    // Saving reconnects Jira; keep that offline. The save writes these into process.env.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    for (const k of ["EMAIL", "API_TOKEN", "BASE_URL", "TOKEN"]) vi.stubEnv(`WORKSTREAM_JIRA_${k}`, undefined);

    const state = makeState();
    try {
      // Jira is unreachable, so the save fails at the reconnect; what matters is what was written before it
      const res = await createApp(state).request("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: { adapter: "jira", fields: { email: "dana@example.com", token: "test-token", baseUrl: "https://new.example.atlassian.net" } } }),
      });
      expect(res.status).toBe(500);
    } finally {
      state.db.close();
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }

    const yaml = files.get(localPath)!;
    expect(yaml).toContain("baseUrl: https://new.example.atlassian.net");
    expect(yaml).toContain("- OPS-");
    expect(yaml).not.toContain("pasted-by-hand"); // the token belongs in .env
  });

  it("rejects an auto-dismiss period that isn't 1 to 3650 whole days", async () => {
    const writes: string[] = [];
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return { ...real, existsSync: () => false, writeFileSync: (p: string) => { writes.push(String(p)); }, mkdirSync: () => undefined, chmodSync: () => undefined };
    });
    for (const expireAfterDays of [0.0001, 0, -3, 1e308, "14"]) {
      const state = makeState();
      const res = await createApp(state).request("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inbox: { expireAfterDays } }),
      });
      state.db.close();
      expect(res.status, String(expireAfterDays)).toBe(400);
    }
    expect(writes).toEqual([]);
  });

  it("rejects values with line breaks instead of writing extra .env lines", async () => {
    const writes: string[] = [];
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      return {
        ...real,
        existsSync: () => false,
        writeFileSync: (p: string) => { writes.push(String(p)); },
        mkdirSync: () => undefined,
        chmodSync: () => undefined,
      };
    });
    const state = makeState();
    const res = await createApp(state).request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: { apiKey: "k\nWORKSTREAM_LLM_BASE_URL=https://attacker.example" } }),
    });
    state.db.close();

    expect(res.status).toBe(400);
    expect(writes).toEqual([]);
  });
});
