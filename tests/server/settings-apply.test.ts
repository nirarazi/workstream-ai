import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ws-settings-"));
mkdirSync(join(root, "config", "prompts"), { recursive: true });
writeFileSync(join(root, "config", "prompts", "classify.yaml"), "system: test\nfew_shot_examples: []\n");
let nextConfig: any;

// Settings writes and reloads config from the project root; point both at a scratch dir and a known config
vi.mock("../../core/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/config.js")>()),
  findProjectRoot: () => root,
  resetConfig: () => undefined,
  loadConfig: () => nextConfig,
}));

const { Database } = await import("../../core/graph/db.js");
const { ContextGraph } = await import("../../core/graph/index.js");
const { createApp, settingsNeedRestart } = await import("../../core/server.js");
const { registerMessagingAdapter } = await import("../../core/adapters/registry.js");

// A stand-in chat adapter, so the restart path never reaches a real platform
const connect = vi.fn(async () => undefined);
registerMessagingAdapter("fakechat", () => ({
  name: "fakechat",
  displayName: "Fake chat",
  getSetupInfo: () => ({ name: "fakechat", displayName: "Fake chat", fields: [{ key: "token", label: "Token", type: "password", required: true, envVar: "FAKECHAT_TOKEN" }] }),
  connect,
  readThreads: async () => [],
  replyToThread: async () => undefined,
  getUsers: async () => new Map(),
  getThreadMessages: async () => [],
}) as any);

function config(inbox: { expireAfterDays: number | null }) {
  return {
    messaging: { pollInterval: 3600, channels: [] },
    classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
    lookback: { initialDays: 1, maxThreadsPerPoll: 10 },
    server: { port: 9847, host: "127.0.0.1" },
    llmBudget: { dailyBudget: null, inputCostPerMillion: null, outputCostPerMillion: null },
    inbox: { ...inbox, handoffMinConfidence: 0.6 },
  } as any;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("saving inbox settings", () => {
  let db: InstanceType<typeof Database>;
  let graph: InstanceType<typeof ContextGraph>;
  let state: any;
  let pipeline: { stop: ReturnType<typeof vi.fn>; setConfig: ReturnType<typeof vi.fn>; isPolling: () => boolean };

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertAgent({ id: "agent-1", name: "Atlas", platform: "slack", platformUserId: "U001" });
    graph.upsertWorkItem({ id: "OPS-101", source: "jira", title: "Old ask", currentAtcStatus: "blocked_on_human" });
    graph.upsertThread({ id: "T1", channelId: "C001", channelName: "general", platform: "slack", workItemId: "OPS-101" });
    graph.insertEvent({
      threadId: "T1", messageId: "m1", workItemId: "OPS-101", agentId: "agent-1", status: "blocked_on_human",
      confidence: 0.9, reason: "", rawText: "", timestamp: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      entryType: "block", targetedAtOperator: true,
    });
    pipeline = { stop: vi.fn(), setConfig: vi.fn(), isPolling: () => true };
    state = {
      config: config({ expireAfterDays: null }), db, graph, pipeline, linker: {},
      messagingAdapter: { name: "fakechat" }, taskAdapter: null, usageTracker: null, rateLimiters: {}, operatorIdentities: new Map(),
    };
    nextConfig = config({ expireAfterDays: 14 });
    process.env.FAKECHAT_TOKEN = "token-a";
    connect.mockClear();
  });

  afterEach(() => {
    if (state.pipeline !== pipeline) state.pipeline?.stop(); // a real pipeline started by the restart path
    delete process.env.FAKECHAT_TOKEN;
    db.close();
  });

  // The real Settings form re-sends every saved credential along with the change
  const save = (token: string) =>
    createApp(state).request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging: { adapter: "fakechat", fields: { token } }, inbox: { expireAfterDays: 14 } }),
    });

  it("auto-dismisses right away and keeps the running pipeline when credentials are re-sent unchanged", async () => {
    const res = await save("token-a");

    expect(res.status).toBe(200);
    expect(graph.getActionableItems()).toEqual([]);
    expect(graph.getWorkItemById("OPS-101")!.dismissReason).toBe("expired");
    expect(pipeline.stop).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(pipeline.setConfig).toHaveBeenCalledWith(nextConfig);
  });

  it("reconnects with a changed credential, so a rotated token takes effect", async () => {
    const res = await save("token-b");

    expect(res.status).toBe(200);
    expect(pipeline.stop).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ token: "token-b" }));
  });

  it("still restarts when the pipeline isn't polling, so Save can revive a stalled one", async () => {
    pipeline.isPolling = () => false;
    await save("token-a");
    expect(pipeline.stop).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });

  it("still reconnects an adapter that failed to connect at startup", async () => {
    state.messagingAdapter = null;
    await save("token-a");
    expect(pipeline.stop).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });
});

describe("settingsNeedRestart", () => {
  it("is false when only inbox settings changed, true for anything else or a changed credential", () => {
    const before = config({ expireAfterDays: null });
    expect(settingsNeedRestart(before, config({ expireAfterDays: 14 }), false)).toBe(false);
    const otherModel = config({ expireAfterDays: null });
    otherModel.classifier.provider.model = "other";
    expect(settingsNeedRestart(before, otherModel, false)).toBe(true);
    expect(settingsNeedRestart(before, config({ expireAfterDays: null }), true)).toBe(true);
  });
});
