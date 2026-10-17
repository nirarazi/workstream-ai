// tests/server/avatars-api.test.ts — API responses name avatars on the engine, which serves them itself

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";

const AVATAR = "https://avatars.example/u/atlas_48.png";

function makeState(): EngineState {
  const db = new Database(":memory:");
  const graph = new ContextGraph(db);
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
    classifier: new Classifier({ name: "mock", classify: vi.fn() }, "sys", []),
    usageTracker: null,
    linker: new WorkItemLinker(graph, [new DefaultExtractor({ ticketPatterns: [], prPatterns: [] })]),
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    rateLimiters: {},
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
  } as any;
}

describe("avatars through the engine", () => {
  let state: EngineState;
  const request = vi.fn(async (_url: string, _signal: AbortSignal) => ({
    status: 200,
    header: (name: string) => ({ "content-type": "image/png" })[name.toLowerCase()],
    body: (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })(),
    discard: () => {},
  }));
  const app = () => createApp(state, { avatarRequest: request });

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ name: "Atlas", platform: "slack", platformUserId: "U0ATLAS0001", avatarUrl: AVATAR, isBot: true });
  });

  afterEach(() => {
    state.db.close();
    request.mockClear();
  });

  it("names each avatar by a path on the engine, never its original URL", async () => {
    const res = await app().request("/api/agents");
    const text = await res.text();
    expect(text).not.toContain("avatars.example");
    const { agents } = JSON.parse(text) as { agents: Array<{ avatarUrl: string }> };
    expect(agents[0].avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f]{32}$/);
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("serves the image, inert even if opened directly", async () => {
    const engine = app();
    const { agents } = (await (await engine.request("/api/agents")).json()) as { agents: Array<{ avatarUrl: string }> };
    const res = await engine.request(agents[0].avatarUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(request.mock.calls[0][0]).toBe(AVATAR);
  });

  it("serves a member's avatar after a restart, before handing it out again", async () => {
    const { agents } = (await (await app().request("/api/agents")).json()) as { agents: Array<{ avatarUrl: string }> };
    expect((await app().request(agents[0].avatarUrl)).status).toBe(200);
  });

  it("leaves responses that aren't JSON, and keeps status and CORS headers on those it rewrites", async () => {
    const engine = app();
    const preflight = await engine.request("/api/agents", {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    const res = await engine.request("/api/agents", { headers: { Origin: "tauri://localhost" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    const missing = await engine.request("/api/work-item/nope");
    expect(missing.status).toBe(404);
  });

  it("fetches nothing for an id it doesn't know, or a URL in the path", async () => {
    const engine = app();
    expect((await engine.request(`/api/avatars/${"0".repeat(32)}`)).status).toBe(404);
    expect((await engine.request(`/api/avatars/${encodeURIComponent("https://evil.example/x.png")}`)).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });
});
