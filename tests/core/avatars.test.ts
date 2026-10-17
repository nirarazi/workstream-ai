// tests/core/avatars.test.ts — The engine serves members' avatars itself: only stored ones, and safely

import { describe, it, expect, vi, afterEach } from "vitest";
import { AvatarStore, httpsRequest, isPrivateAddress, publicOnlyLookup, type AvatarResponse } from "../../core/avatars.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const URL_A = "https://avatars.example/u/atlas_48.png";

function response(status: number, headers: Record<string, string>, body: Uint8Array = new Uint8Array()): AvatarResponse & { discarded: boolean } {
  const res = {
    status,
    header: (name: string) => headers[name.toLowerCase()],
    body: (async function* () {
      yield body;
    })(),
    discarded: false,
    discard: () => {
      res.discarded = true;
    },
  };
  return res;
}
const image = (type = "image/png", body: Uint8Array = PNG, extra: Record<string, string> = {}) =>
  response(200, { "content-type": type, ...extra }, body);
const redirect = (location: string) => response(302, { location });

function store(responses: Array<AvatarResponse | Error>, stored: string[] = [URL_A]) {
  const request = vi.fn(async (_url: string, _signal: AbortSignal) => {
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response");
    return next;
  });
  const avatars = new AvatarStore(() => stored, request);
  const idFor = (url: string) => avatars.pathFor(url)!.split("/").pop()!;
  return { avatars, request, idFor };
}

afterEach(() => vi.useRealTimers());

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
  it("fetches a member's stored avatar, once", async () => {
    const { avatars, request, idFor } = store([image()]);
    expect(await avatars.get(idFor(URL_A))).toEqual({ body: Buffer.from(PNG), type: "image/png" });
    expect(await avatars.get(idFor(URL_A))).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(URL_A);
  });

  it("serves only members' stored avatars, never a URL some response named (a model's answer, say)", async () => {
    const injected = "https://attacker.example/beacon.png";
    const { avatars, request, idFor } = store([image()]);
    avatars.rewrite({ sources: [{ args: { avatarUrl: injected } }] });
    expect(await avatars.get(idFor(injected))).toBeNull();
    expect(await avatars.get("0".repeat(32))).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("serves a member's avatar stored after it started", async () => {
    const stored: string[] = [];
    vi.useFakeTimers();
    const { avatars, idFor } = store([image()], stored);
    expect(await avatars.get(idFor(URL_A))).toBeNull();
    stored.push(URL_A);
    vi.advanceTimersByTime(1000);
    expect(await avatars.get(idFor(URL_A))).not.toBeNull();
  });

  it("downloads once however many ask at once", async () => {
    let release: (r: AvatarResponse) => void = () => {};
    const request = vi.fn(() => new Promise<AvatarResponse>((resolve) => (release = resolve)));
    const avatars = new AvatarStore(() => [URL_A], request);
    const id = avatars.pathFor(URL_A)!.split("/").pop()!;
    const all = Promise.all(Array.from({ length: 10 }, () => avatars.get(id)));
    release(image());
    expect((await all).every((i) => i !== null)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["image/svg+xml", "text/html", "application/octet-stream", ""])("refuses a %s response, and lets it go", async (type) => {
    const res = image(type);
    const { avatars, idFor } = store([res]);
    expect(await avatars.get(idFor(URL_A))).toBeNull();
    expect(res.discarded).toBe(true);
  });

  it("refuses an image over the size limit, whatever it says its length is", async () => {
    const big = new Uint8Array(256 * 1024 + 1);
    for (const extra of [{}, { "content-length": String(big.byteLength) }]) {
      const { avatars, idFor } = store([image("image/png", big, extra)]);
      expect(await avatars.get(idFor(URL_A))).toBeNull();
    }
  });

  it("follows a few https redirects, relative ones too, and never one to http", async () => {
    const ok = store([redirect("/elsewhere/a.png"), image()]);
    expect(await ok.avatars.get(ok.idFor(URL_A))).not.toBeNull();
    expect(ok.request.mock.calls[1][0]).toBe("https://avatars.example/elsewhere/a.png");
    const down = store([redirect("http://169.254.169.254/latest/meta-data"), image()]);
    expect(await down.avatars.get(down.idFor(URL_A))).toBeNull();
    expect(down.request).toHaveBeenCalledTimes(1);
    const loop = store(Array.from({ length: 5 }, () => redirect("https://cdn.example/again")));
    expect(await loop.avatars.get(loop.idFor(URL_A))).toBeNull();
    expect(loop.request).toHaveBeenCalledTimes(4);
  });

  it("retries a failed avatar after a while, not on every request", async () => {
    vi.useFakeTimers();
    const { avatars, request, idFor } = store([new Error("offline"), image()]);
    expect(await avatars.get(idFor(URL_A))).toBeNull();
    expect(await avatars.get(idFor(URL_A))).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await avatars.get(idFor(URL_A))).not.toBeNull();
  });

  it("keeps its cache within a total size", async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `https://avatars.example/${i}.png`);
    const body = new Uint8Array(256 * 1024);
    const { avatars, request, idFor } = store(urls.map(() => image("image/png", body)), urls);
    for (const url of urls) await avatars.get(idFor(url));
    // 100 × 256 KB is over the 20 MB budget, so the first ones were let go and come back by fetching again
    await avatars.get(idFor(urls[0]));
    expect(request).toHaveBeenCalledTimes(101);
  });
});

describe("where avatars may come from", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "::7f00:1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not an address",
  ])("never %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34"])("a public address like %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("refuses a name that resolves to this machine", async () => {
    const err = await new Promise<Error | null>((resolve) => publicOnlyLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/private address/);
  });

  it("refuses a private address written into the URL, without connecting", async () => {
    for (const url of ["https://127.0.0.1/a.png", "https://[::1]/a.png", "https://10.0.0.1/a.png"]) {
      await expect(httpsRequest(url, AbortSignal.timeout(1000)), url).rejects.toThrow(/private address/);
    }
  });
});
