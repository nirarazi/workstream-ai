// tests/lib/engine-url.test.ts — The UI calls the engine it was served by, unless it runs in the desktop app

import { describe, it, expect, vi, afterEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string) => "http://127.0.0.1:9999"));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  invoke.mockClear();
});

/** The URL the first API call goes to, from a freshly loaded api module */
async function firstCallUrl(): Promise<string> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const { fetchAllActive } = await import("../../src/lib/api.js");
  await fetchAllActive();
  return String((fetchMock.mock.calls[0] as unknown[])[0]);
}

describe("which engine the UI calls", () => {
  it("in a browser, the origin that served the page", async () => {
    vi.stubEnv("VITE_ENGINE_URL", "");
    expect(await firstCallUrl()).toBe(`${window.location.origin}/api/stream/all-active`);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("in a browser, the configured engine when there is one", async () => {
    vi.stubEnv("VITE_ENGINE_URL", "http://127.0.0.1:9850");
    expect(await firstCallUrl()).toBe("http://127.0.0.1:9850/api/stream/all-active");
  });

  it("in the desktop app, the engine the app started", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await firstCallUrl()).toBe("http://127.0.0.1:9999/api/stream/all-active");
    expect(invoke).toHaveBeenCalledWith("get_engine_url");
  });
});
