// core/avatars.ts — Member avatars served by the engine, so the UI loads images from nowhere else

import { createHash } from "node:crypto";

/** Image types an avatar may be. Never SVG: it can carry script, and the engine serves it from its own origin. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;
const CACHE_ENTRIES = 500;
const FRESH_MS = 24 * 60 * 60 * 1000;
const FAILED_MS = 10 * 60 * 1000;

/** The keys under which API responses carry an avatar URL */
const AVATAR_KEYS = new Set(["avatarUrl", "agentAvatarUrl"]);

export interface AvatarImage {
  body: Uint8Array;
  type: string;
}

type Cached = { image: AvatarImage | null; at: number };

const idOf = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 32);

/**
 * Avatars by an opaque id. The engine fetches only URLs it handed out itself, from what adapters stored, never a URL
 * a request names; and only over https, only raster images, and only up to a size limit.
 */
export class AvatarStore {
  private readonly urls = new Map<string, string>();
  private readonly cache = new Map<string, Cached>();

  constructor(
    /** Every avatar URL the engine knows, to find one handed out before a restart */
    private readonly knownUrls: () => Iterable<string | null>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The path the UI loads this avatar from, or null when there's none it may load */
  pathFor(url: string | null | undefined): string | null {
    if (typeof url !== "string" || !url.startsWith("https://")) return null;
    const id = idOf(url);
    if (!this.urls.has(id) && this.urls.size >= CACHE_ENTRIES * 4) this.urls.clear();
    this.urls.set(id, url);
    return `/api/avatars/${id}`;
  }

  /** A copy of an API response's data with each avatar URL replaced by its path */
  rewrite<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, AVATAR_KEYS.has(k) ? this.pathFor(x as string | null) : walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  /** The image for an id from `pathFor`, or null when it's unknown or couldn't be fetched */
  async get(id: string): Promise<AvatarImage | null> {
    let url = this.urls.get(id);
    if (!url) {
      for (const known of this.knownUrls()) {
        if (known && known.startsWith("https://") && idOf(known) === id) url = known;
      }
      if (!url) return null;
      this.urls.set(id, url);
    }
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < (cached.image ? FRESH_MS : FAILED_MS)) return cached.image;

    const image = await this.download(url).catch(() => null);
    this.cache.delete(id);
    if (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { image, at: Date.now() });
    return image;
  }

  private async download(url: string): Promise<AvatarImage | null> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return null;
        current = new URL(next, current).href;
        if (!current.startsWith("https://")) return null;
        continue;
      }
      if (!res.ok || !res.body) return null;
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) return null;
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) return null;
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), type };
    }
    return null;
  }
}
