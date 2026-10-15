import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ws-settings-"));
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

function config(inbox: { expireAfterDays: number | null }) {
  return {
    messaging: { pollInterval: 30, channels: [] },
    classifier: { provider: { baseUrl: "http://localhost", model: "test" }, confidenceThreshold: 0.6 },
    server: { port: 9847, host: "127.0.0.1" },
    llmBudget: { dailyBudget: null, inputCostPerMillion: null, outputCostPerMillion: null },
    inbox: { ...inbox, handoffMinConfidence: 0.6 },
  } as any;
}

describe("saving inbox settings", () => {
  let db: InstanceType<typeof Database>;
  let graph: InstanceType<typeof ContextGraph>;

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
  });

  afterEach(() => {
    db.close();
  });

  it("auto-dismisses right away and keeps the running pipeline, instead of restarting and catching up", async () => {
    const pipeline = { stop: vi.fn(), setConfig: vi.fn() };
    const state = {
      config: config({ expireAfterDays: null }), db, graph, pipeline,
      messagingAdapter: { name: "slack" }, taskAdapter: null, usageTracker: null, rateLimiters: {}, operatorIdentities: new Map(),
    } as any;
    nextConfig = config({ expireAfterDays: 14 });

    const res = await createApp(state).request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inbox: { expireAfterDays: 14 } }),
    });

    expect(res.status).toBe(200);
    expect(graph.getActionableItems()).toEqual([]);
    expect(graph.getWorkItemById("OPS-101")!.dismissReason).toBe("expired");
    expect(pipeline.stop).not.toHaveBeenCalled();
    expect(pipeline.setConfig).toHaveBeenCalledWith(nextConfig);
    expect(state.pipeline).toBe(pipeline);
  });
});

describe("settingsNeedRestart", () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is false when only inbox settings changed, true for anything else or a changed credential", () => {
    const before = config({ expireAfterDays: null });
    expect(settingsNeedRestart(before, config({ expireAfterDays: 14 }), false)).toBe(false);
    const otherModel = config({ expireAfterDays: null });
    otherModel.classifier.provider.model = "other";
    expect(settingsNeedRestart(before, otherModel, false)).toBe(true);
    expect(settingsNeedRestart(before, config({ expireAfterDays: null }), true)).toBe(true);
  });
});
