import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
const { createApp, untilDeadlineOrSuperseded } = await import("../../core/server.js");
const { registerMessagingAdapter } = await import("../../core/adapters/registry.js");

// A stand-in chat adapter whose connect takes a moment, like a real platform, records overlap, and hangs for
// the token "hang"
let connecting = 0;
let maxConnecting = 0;
registerMessagingAdapter("slowchat", () => ({
  name: "slowchat",
  displayName: "Slow chat",
  getSetupInfo: () => ({ name: "slowchat", displayName: "Slow chat", fields: [{ key: "token", label: "Token", type: "password", required: true, envVar: "SLOWCHAT_TOKEN" }] }),
  connect: async (creds: { token: string }) => {
    if (creds.token === "hang") return new Promise<void>(() => {});
    maxConnecting = Math.max(maxConnecting, ++connecting);
    await new Promise((r) => setTimeout(r, 20));
    connecting--;
  },
  readThreads: async () => [],
  getUsers: async () => new Map(),
}) as any);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("POST /api/setup", () => {
  let db: InstanceType<typeof Database>;
  let state: any;
  let started: unknown[];
  let stop: ReturnType<typeof vi.spyOn>;
  let save: (body: unknown) => Promise<Response>;

  beforeEach(() => {
    started = [];
    maxConnecting = 0;
    vi.spyOn(Pipeline.prototype, "start").mockImplementation(async function (this: unknown) { started.push(this); });
    stop = vi.spyOn(Pipeline.prototype, "stop");
    db = new Database(":memory:");
    state = {
      config, db, graph: new ContextGraph(db), linker: {}, pipeline: null,
      messagingAdapter: null, taskAdapter: null, usageTracker: null, rateLimiters: {}, operatorIdentities: new Map(),
    };
    const app = createApp(state);
    save = (body) => app.request("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  });

  afterEach(() => {
    delete process.env.SLOWCHAT_TOKEN;
    vi.restoreAllMocks();
    db.close();
  });

  const chat = (token: string) => ({ messaging: { adapter: "slowchat", fields: { token } } });

  it("runs one save at a time, so a double click can't leave two pipelines polling", async () => {
    const [a, b] = await Promise.all([save(chat("token-1")), save(chat("token-2"))]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(maxConnecting).toBe(1);
    expect(started).toHaveLength(2);
    expect(stop.mock.contexts).toContain(started[0]); // the second save stopped the first save's pipeline
    expect(state.pipeline).toBe(started[1]);
  });

  it("gives up a hung connect as soon as a newer save is waiting, so that save isn't held up", async () => {
    const [hung, next] = await Promise.all([save(chat("hang")), save(chat("token-2"))]);

    expect(hung.status).toBe(500);
    expect((await hung.json()).error).toMatch(/newer settings save/);
    expect(next.status).toBe(200);
    expect(state.pipeline).toBe(started[0]);
  });

  it("keeps the queue moving after a failed save, and doesn't leave a retired tracker in place", async () => {
    const [bad, good] = await Promise.all([
      save({ messaging: { adapter: "no-such-chat", fields: { token: "x" } } }),
      save(chat("token-2")),
    ]);

    expect([bad.status, good.status]).toEqual([500, 200]);
    expect(started).toHaveLength(1);
    expect(state.usageTracker.isDisposed).toBe(false);
  });
});

describe("untilDeadlineOrSuperseded", () => {
  it("fails a connect that never finishes", async () => {
    const never = new Promise<void>(() => {});
    await expect(untilDeadlineOrSuperseded(never, 20, "slowchat connect")).rejects.toThrow("slowchat connect timed out");
  });

  it("passes a result through", async () => {
    await expect(untilDeadlineOrSuperseded(Promise.resolve("ok"), 1000, "x")).resolves.toBe("ok");
  });
});
