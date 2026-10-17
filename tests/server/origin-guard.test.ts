import { readFileSync } from "node:fs";
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
  const classifier = new Classifier({ name: "mock", classify: vi.fn() }, "sys", []);
  const linker = new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]);
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
    messagingAdapter: { replyToThread: vi.fn() } as any,
    taskAdapter: null,
    rateLimiters: {},
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
  } as any;
}

const REPLY = JSON.stringify({ threadId: "t1", channelId: "c1", message: "approved" });

describe("engine API only takes writes from its own UI", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    state.db.close();
  });

  const post = (headers: Record<string, string>, body = REPLY) =>
    createApp(state).request("/api/reply", { method: "POST", headers, body });

  it("refuses a write from another site, so a web page can't post to Slack as the operator", async () => {
    const res = await post({ Origin: "https://evil.example", "Content-Type": "application/json" });
    expect(res.status).toBe(403);
    expect(state.messagingAdapter!.replyToThread).not.toHaveBeenCalled();
  });

  it("refuses an opaque origin (sandboxed iframe, file://)", async () => {
    const res = await post({ Origin: "null", "Content-Type": "application/json" });
    expect(res.status).toBe(403);
  });

  it("refuses a write that isn't JSON, which a page can send without a CORS preflight", async () => {
    const res = await post({ "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
    expect(state.messagingAdapter!.replyToThread).not.toHaveBeenCalled();
  });

  it("refuses any request addressed to a name other than this machine (DNS rebinding)", async () => {
    const res = await createApp(state).request("/api/setup/prefill", { headers: { Host: "evil.example:9847" } });
    expect(res.status).toBe(403);
  });

  it.each([
    "tauri://localhost",
    "http://tauri.localhost",
    "http://127.0.0.1:9847",
    "http://localhost:9847",
  ])("accepts writes from the app's own origin %s", async (origin) => {
    const res = await post({ Origin: origin, Host: "127.0.0.1:9847", "Content-Type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
    expect(state.messagingAdapter!.replyToThread).toHaveBeenCalledWith("t1", "c1", "approved");
  });

  it("accepts writes from local tools that send no Origin", async () => {
    const res = await post({ "Content-Type": "application/json" });
    expect(res.status).toBe(200);
  });

  it("still lets the UI read", async () => {
    const res = await createApp(state).request("/api/status", { headers: { Host: "127.0.0.1:9847", Origin: "tauri://localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
  });
});

describe("the Vite dev server's origin is trusted only in development", () => {
  let state: EngineState;

  beforeEach(() => {
    state = makeState();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    state.db.close();
  });

  const post = (origin: string) =>
    createApp(state).request("/api/reply", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: REPLY });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
    "refuses writes from %s otherwise, so another program on that port can't post as the operator",
    async (origin) => {
      vi.stubEnv("WORKSTREAM_DEV_UI", "");
      const res = await post(origin);
      expect(res.status).toBe(403);
      expect(state.messagingAdapter!.replyToThread).not.toHaveBeenCalled();
      const read = await createApp(state).request("/api/status", { headers: { Origin: origin } });
      expect(read.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])("accepts writes from %s when the dev scripts start the engine", async (origin) => {
    vi.stubEnv("WORKSTREAM_DEV_UI", "true");
    const res = await post(origin);
    expect(res.status).toBe(200);
    expect(state.messagingAdapter!.replyToThread).toHaveBeenCalledWith("t1", "c1", "approved");
  });
});

describe("dev scripts", () => {
  it("tell the engine it serves the Vite dev server, and only the dev scripts do", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(scripts.engine).toContain("WORKSTREAM_DEV_UI=true");
    expect(scripts["dev:web"]).toContain("WORKSTREAM_DEV_UI=true");
    expect(scripts["start:web"]).not.toContain("WORKSTREAM_DEV_UI");
    const shell = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(shell.match(/WORKSTREAM_DEV_UI=true npx tsx watch core\/server\.ts/g)).toHaveLength(1);
    expect(shell).toContain('"cd \'{}\' && exec npx tsx core/server.ts"');
  });
});
