// core/avatars.ts — Member avatars served by the engine, so the UI loads images from nowhere else

import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { get as httpsGet } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Image types an avatar may be. Never SVG: it can carry script, and the engine serves it from its own origin. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Plenty for an avatar (a 48px one is a few KB) */
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;
const CACHE_ENTRIES = 500;
const CACHE_BYTES = 20 * 1024 * 1024;
const FRESH_MS = 24 * 60 * 60 * 1000;
const FAILED_MS = 10 * 60 * 1000;
/** How often an unknown id may make the store re-read the avatars it may serve */
const RELOAD_MS = 1000;

/** The keys under which API responses carry an avatar URL */
const AVATAR_KEYS = new Set(["avatarUrl", "agentAvatarUrl"]);

export interface AvatarImage {
  body: Uint8Array;
  type: string;
}

/** One response, as the store reads it */
export interface AvatarResponse {
  status: number;
  header: (name: string) => string | undefined;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading, releasing the connection */
  discard: () => void;
}

export type AvatarRequest = (url: string, signal: AbortSignal) => Promise<AvatarResponse>;

type Cached = { image: AvatarImage | null; at: number };

const idOf = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 32);

/** Addresses an avatar may never be fetched from: this machine, private networks, link-local and the like */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2002::", 16]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** Whether an address is out of bounds, IPv4 written as IPv6 included */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1], "ipv4");
  const family = isIP(address);
  return family === 0 || PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** DNS lookup for avatar fetches: refuses names that resolve to a private address, checked as the connection is made */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/** Fetches over https from public addresses only */
export const httpsRequest: AvatarRequest = (url, signal) =>
  new Promise((resolve, reject) => {
    const { hostname } = new URL(url);
    const literal = hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && isPrivateAddress(literal)) return reject(new Error("private address"));
    const req = httpsGet(url, { lookup: publicOnlyLookup, signal, headers: { Accept: "image/*" } }, (res) =>
      resolve({
        status: res.statusCode ?? 0,
        header: (name) => {
          const value = res.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
        body: res,
        discard: () => res.destroy(),
      }),
    );
    req.on("error", reject);
  });

/**
 * Avatars by an opaque id. The engine serves only avatars stored on members (what messaging adapters recorded),
 * never a URL a request or a response names; and only over https from public addresses, only raster images, and
 * only up to a size limit.
 */
export class AvatarStore {
  private servable = new Map<string, string>();
  private loadedAt = 0;
  private readonly ids = new Map<string, string>();
  private readonly cache = new Map<string, Cached>();
  private cachedBytes = 0;
  private readonly inFlight = new Map<string, Promise<AvatarImage | null>>();

  constructor(
    /** The avatar URLs stored on members: the only ones the store fetches */
    private readonly storedUrls: () => Iterable<string | null>,
    private readonly request: AvatarRequest = httpsRequest,
  ) {}

  /** The path the UI loads this avatar from, or null when there's none it may load */
  pathFor(url: string | null | undefined): string | null {
    if (typeof url !== "string" || !url.startsWith("https://")) return null;
    let id = this.ids.get(url);
    if (!id) {
      if (this.ids.size >= CACHE_ENTRIES * 4) this.ids.clear();
      id = idOf(url);
      this.ids.set(url, id);
    }
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

  /** The image for an id from `pathFor`, or null when it isn't a member's avatar or couldn't be fetched */
  async get(id: string): Promise<AvatarImage | null> {
    const url = this.urlFor(id);
    if (!url) return null;
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < (cached.image ? FRESH_MS : FAILED_MS)) return cached.image;
    // One download per avatar, however many ask at once
    let pending = this.inFlight.get(id);
    if (!pending) {
      pending = this.download(url)
        .catch(() => null)
        .then((image) => {
          this.remember(id, image);
          return image;
        })
        .finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, pending);
    }
    return pending;
  }

  private urlFor(id: string): string | undefined {
    if (!this.servable.has(id) && Date.now() - this.loadedAt >= RELOAD_MS) {
      this.servable = new Map();
      for (const url of this.storedUrls()) {
        if (url && url.startsWith("https://")) this.servable.set(idOf(url), url);
      }
      this.loadedAt = Date.now();
    }
    return this.servable.get(id);
  }

  /** Caches by insertion order, within a count and a total size */
  private remember(id: string, image: AvatarImage | null): void {
    this.forget(id);
    const size = image?.body.byteLength ?? 0;
    while (this.cache.size > 0 && (this.cache.size >= CACHE_ENTRIES || this.cachedBytes + size > CACHE_BYTES)) {
      this.forget(this.cache.keys().next().value!);
    }
    this.cache.set(id, { image, at: Date.now() });
    this.cachedBytes += size;
  }

  private forget(id: string): void {
    const entry = this.cache.get(id);
    if (!entry) return;
    this.cachedBytes -= entry.image?.body.byteLength ?? 0;
    this.cache.delete(id);
  }

  private async download(url: string): Promise<AvatarImage | null> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.request(current, signal);
      if (res.status >= 300 && res.status < 400) {
        const next = res.header("location");
        res.discard();
        if (!next) return null;
        current = new URL(next, current).href;
        if (!current.startsWith("https://")) return null;
        continue;
      }
      const type = (res.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (res.status !== 200 || !IMAGE_TYPES.has(type) || Number(res.header("content-length") ?? 0) > MAX_BYTES) {
        res.discard();
        return null;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) {
          res.discard();
          return null;
        }
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), type };
    }
    return null;
  }
}
