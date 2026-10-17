import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Classifier } from "../../core/classifier/index.js";
import { WorkItemLinker } from "../../core/graph/linker.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import { createApp, type EngineState } from "../../core/server.js";
import { DEV_UI_DIR, DEV_UI_HEADER, createDevUiSecret, devUiProxy, isDevUiSecret } from "../../core/dev-ui.js";

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
    "http://[::1]:9847",
  ])("accepts writes from the app's own origin %s", async (origin) => {
    const res = await post({ Origin: origin, Host: "127.0.0.1:9847", "Content-Type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
    expect(state.messagingAdapter!.replyToThread).toHaveBeenCalledWith("t1", "c1", "approved");
  });

  it("accepts writes from local tools that send no Origin", async () => {
    const res = await post({ "Content-Type": "application/json" });
    expect(res.status).toBe(200);
  });

  it("tells browsers not to guess its responses' types", async () => {
    const res = await createApp(state).request("/api/status");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still lets the UI read", async () => {
    const res = await createApp(state).request("/api/status", { headers: { Host: "127.0.0.1:9847", Origin: "tauri://localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
  });
});

describe("the Vite dev server is trusted only through its own proxy, in development", () => {
  let state: EngineState;
  let root: string;
  let secret: string;

  beforeEach(() => {
    state = makeState();
    root = mkdtempSync(join(tmpdir(), "dev-ui-"));
    secret = createDevUiSecret(root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    state.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const request = (path: string, origin: string, extra: Record<string, string> = {}, method = "POST") =>
    createApp(state, { projectRoot: root }).request(path, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json", ...extra },
      body: method === "POST" ? REPLY : undefined,
    });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
    "refuses %s without the dev server's secret, so another page on that port can't act or read as the operator",
    async (origin) => {
      vi.stubEnv("WORKSTREAM_DEV_UI", "true");
      for (const extra of [{}, { [DEV_UI_HEADER]: "0".repeat(64) }, { [DEV_UI_HEADER]: secret.slice(1) }]) {
        expect((await request("/api/reply", origin, extra)).status).toBe(403);
        expect((await request("/api/status", origin, extra, "GET")).status).toBe(403);
      }
      expect(state.messagingAdapter!.replyToThread).not.toHaveBeenCalled();
    },
  );

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])("accepts %s with the secret when the dev scripts start the engine", async (origin) => {
    vi.stubEnv("WORKSTREAM_DEV_UI", "true");
    const res = await request("/api/reply", origin, { [DEV_UI_HEADER]: secret });
    expect(res.status).toBe(200);
    expect(state.messagingAdapter!.replyToThread).toHaveBeenCalledWith("t1", "c1", "approved");
  });

  it("accepts a restarted dev server's new secret, and not the old one", async () => {
    vi.stubEnv("WORKSTREAM_DEV_UI", "true");
    const fresh = createDevUiSecret(root);
    expect((await request("/api/reply", "http://localhost:5173", { [DEV_UI_HEADER]: secret })).status).toBe(403);
    expect((await request("/api/reply", "http://localhost:5173", { [DEV_UI_HEADER]: fresh })).status).toBe(200);
  });

  it("refuses the dev server outside development, secret or not", async () => {
    vi.stubEnv("WORKSTREAM_DEV_UI", "");
    expect((await request("/api/reply", "http://localhost:5173", { [DEV_UI_HEADER]: secret })).status).toBe(403);
  });

  it("never lets another site read through CORS", async () => {
    vi.stubEnv("WORKSTREAM_DEV_UI", "true");
    const res = await request("/api/status", "http://localhost:5173", { [DEV_UI_HEADER]: secret }, "GET");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the dev server's proxy", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dev-ui-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const from = (remoteAddress: string) => ({ socket: { remoteAddress } }) as unknown as IncomingMessage;

  it("forwards requests from this machine only, so the network can't reach the engine through it", () => {
    const { bypass } = devUiProxy(root, "http://127.0.0.1:9847");
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(bypass(from(address)), address).toBeUndefined();
    for (const address of ["192.168.1.20", "::ffff:10.0.0.5", "fe80::1", ""]) expect(bypass(from(address)), address).toBe(false);
  });

  it("adds a fresh secret that only this user can read", () => {
    const first = devUiProxy(root, "http://127.0.0.1:9847").headers[DEV_UI_HEADER];
    const second = devUiProxy(root, "http://127.0.0.1:9847").headers[DEV_UI_HEADER];
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(isDevUiSecret(root, second)).toBe(true);
    expect(statSync(join(root, DEV_UI_DIR, "ui-secret")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, DEV_UI_DIR)).mode & 0o777).toBe(0o700);
  });

  it("isn't served by the dev server, nor committed", () => {
    expect(readFileSync("vite.config.ts", "utf8")).toContain("here(DEV_UI_DIR)");
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain(`${DEV_UI_DIR}/`);
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
