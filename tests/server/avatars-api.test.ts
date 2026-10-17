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
  const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }));

  beforeEach(() => {
    state = makeState();
    state.graph.upsertAgent({ name: "Atlas", platform: "slack", platformUserId: "U0ATLAS0001", avatarUrl: AVATAR, isBot: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    state.db.close();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("names each avatar by a path on the engine, never its original URL", async () => {
    const res = await createApp(state).request("/api/agents");
    const text = await res.text();
    expect(text).not.toContain("avatars.example");
    const { agents } = JSON.parse(text) as { agents: Array<{ avatarUrl: string }> };
    expect(agents[0].avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f]{32}$/);
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("serves the image, inert even if opened directly", async () => {
    const app = createApp(state);
    const { agents } = (await (await app.request("/api/agents")).json()) as { agents: Array<{ avatarUrl: string }> };
    const res = await app.request(agents[0].avatarUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(AVATAR);
  });

  it("finds an avatar the engine stored, even before handing it out (after a restart)", async () => {
    const paths: string[] = [];
    const first = createApp(state);
    paths.push(((await (await first.request("/api/agents")).json()) as { agents: Array<{ avatarUrl: string }> }).agents[0].avatarUrl);
    expect((await createApp(state).request(paths[0])).status).toBe(200);
  });

  it("fetches nothing for an id it doesn't know, or a URL in the path", async () => {
    const app = createApp(state);
    expect((await app.request(`/api/avatars/${"0".repeat(32)}`)).status).toBe(404);
    expect((await app.request(`/api/avatars/${encodeURIComponent("https://evil.example/x.png")}`)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
