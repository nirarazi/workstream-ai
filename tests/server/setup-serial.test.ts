import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ws-setup-serial-"));
mkdirSync(join(root, "config", "prompts"), { recursive: true });
writeFileSync(join(root, "config", "prompts", "classify.yaml"), "system: test\nfew_shot_examples: []\n");
const config = {
  messaging: { pollInterval: 3600, channels: [] },
  classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
  lookback: { initialDays: 1, maxThreadsPerPoll: 10 },
  server: { port: 9847, host: "127.0.0.1" },
  llmBudget: { dailyBudget: null, inputCostPerMillion: null, outputCostPerMillion: null },
  inbox: { expireAfterDays: null, handoffMinConfidence: 0.6 },
} as any;

// Settings writes and reloads config from the project root; point both at a scratch dir and a known config
vi.mock("../../core/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/config.js")>()),
  findProjectRoot: () => root,
  resetConfig: () => undefined,
  loadConfig: () => config,
}));

const { Database } = await import("../../core/graph/db.js");
const { ContextGraph } = await import("../../core/graph/index.js");
const { Pipeline } = await import("../../core/pipeline.js");
const { createApp } = await import("../../core/server.js");
const { registerMessagingAdapter } = await import("../../core/adapters/registry.js");

// A stand-in chat adapter whose connect takes a moment, like a real platform, and records overlap
let connecting = 0;
let maxConnecting = 0;
registerMessagingAdapter("slowchat", () => ({
  name: "slowchat",
  displayName: "Slow chat",
  getSetupInfo: () => ({ name: "slowchat", displayName: "Slow chat", fields: [{ key: "token", label: "Token", type: "password", required: true, envVar: "SLOWCHAT_TOKEN" }] }),
  connect: async () => {
    maxConnecting = Math.max(maxConnecting, ++connecting);
    await new Promise((r) => setTimeout(r, 20));
    connecting--;
  },
  readThreads: async () => [],
  getUsers: async () => new Map(),
}) as any);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("POST /api/setup", () => {
  it("runs one save at a time, so a double click can't leave two pipelines polling", async () => {
    const started: unknown[] = [];
    vi.spyOn(Pipeline.prototype, "start").mockImplementation(async function (this: unknown) { started.push(this); });
    const stop = vi.spyOn(Pipeline.prototype, "stop");
    const db = new Database(":memory:");
    const state = {
      config, db, graph: new ContextGraph(db), linker: {}, pipeline: null,
      messagingAdapter: null, taskAdapter: null, usageTracker: null, rateLimiters: {}, operatorIdentities: new Map(),
    } as any;
    const app = createApp(state);
    const save = (token: string) => app.request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging: { adapter: "slowchat", fields: { token } } }),
    });

    const [a, b] = await Promise.all([save("token-1"), save("token-2")]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(maxConnecting).toBe(1);
    expect(started).toHaveLength(2);
    expect(stop.mock.contexts).toContain(started[0]); // the second save stopped the first save's pipeline
    expect(state.pipeline).toBe(started[1]);

    delete process.env.SLOWCHAT_TOKEN;
    vi.restoreAllMocks();
    db.close();
  });
});
