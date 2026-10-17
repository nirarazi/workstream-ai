// tests/core/avatars.test.ts — The engine serves avatars itself, fetching only what it handed out, and safely

import { describe, it, expect, vi } from "vitest";
import { AvatarStore } from "../../core/avatars.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image = (type = "image/png", body: Uint8Array = PNG, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": type, ...extra } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

function store(responses: Array<Response | Error>, known: string[] = []) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response");
    return next;
  });
  return { avatars: new AvatarStore(() => known, fetchMock as unknown as typeof fetch), fetchMock };
}

const URL_A = "https://avatars.example/u/atlas_48.png";

describe("avatars in API responses", () => {
  it("become paths on the engine, wherever they sit", () => {
    const { avatars } = store([]);
    const out = avatars.rewrite({
      items: [{ agent: { name: "Atlas", avatarUrl: URL_A } }],
      timeline: [{ agentAvatarUrl: URL_A, text: URL_A }],
    });
    const path = out.items[0].agent.avatarUrl!;
    expect(path).toMatch(/^\/api\/avatars\/[0-9a-f]{32}$/);
    expect(out.timeline[0].agentAvatarUrl).toBe(path);
    expect(out.timeline[0].text).toBe(URL_A);
  });

  it("are dropped unless https", () => {
    const { avatars } = store([]);
    for (const url of ["http://avatars.example/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "", null]) {
      expect(avatars.rewrite({ avatarUrl: url }).avatarUrl, String(url)).toBeNull();
    }
  });
});

describe("serving an avatar", () => {
  it("fetches the URL it handed out, once", async () => {
    const { avatars, fetchMock } = store([image()]);
    const id = avatars.pathFor(URL_A)!.split("/").pop()!;
    expect(await avatars.get(id)).toEqual({ body: Buffer.from(PNG), type: "image/png" });
    expect(await avatars.get(id)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(URL_A);
  });

  it("knows nothing a request names: only ids of URLs the engine holds", async () => {
    const { avatars, fetchMock } = store([image()]);
    expect(await avatars.get("0".repeat(32))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds an avatar handed out before a restart among the ones the engine knows", async () => {
    const before = store([]).avatars.pathFor(URL_A)!.split("/").pop()!;
    const { avatars } = store([image()], ["https://avatars.example/other.png", URL_A]);
    expect(await avatars.get(before)).not.toBeNull();
  });

  it.each(["image/svg+xml", "text/html", "application/octet-stream", ""])("refuses a %s response", async (type) => {
    const { avatars } = store([image(type)]);
    expect(await avatars.get(avatars.pathFor(URL_A)!.split("/").pop()!)).toBeNull();
  });

  it("refuses an image over the size limit, whatever it says its length is", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    for (const extra of [{}, { "Content-Length": String(big.byteLength) }]) {
      const { avatars } = store([image("image/png", big, extra)]);
      expect(await avatars.get(avatars.pathFor(URL_A)!.split("/").pop()!)).toBeNull();
    }
  });

  it("follows a few https redirects, and never one to http", async () => {
    const ok = store([redirect("https://cdn.example/a.png"), image()]);
    expect(await ok.avatars.get(ok.avatars.pathFor(URL_A)!.split("/").pop()!)).not.toBeNull();
    const down = store([redirect("http://169.254.169.254/latest/meta-data"), image()]);
    expect(await down.avatars.get(down.avatars.pathFor(URL_A)!.split("/").pop()!)).toBeNull();
    expect(down.fetchMock).toHaveBeenCalledTimes(1);
    const loop = store(Array.from({ length: 5 }, () => redirect("https://cdn.example/again")));
    expect(await loop.avatars.get(loop.avatars.pathFor(URL_A)!.split("/").pop()!)).toBeNull();
    expect(loop.fetchMock).toHaveBeenCalledTimes(4);
  });

  it("doesn't retry a failed avatar on every request", async () => {
    const { avatars, fetchMock } = store([new Error("offline"), image()]);
    const id = avatars.pathFor(URL_A)!.split("/").pop()!;
    expect(await avatars.get(id)).toBeNull();
    expect(await avatars.get(id)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
