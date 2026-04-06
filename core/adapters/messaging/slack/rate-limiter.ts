// core/adapters/messaging/slack/rate-limiter.ts
//
// Slack-specific rate limiter: per-method sliding-window buckets matching
// Slack's actual tier limits, plus a global 429 backoff that pauses ALL
// methods when any request is rate-limited.
//
// Slack rate limit tiers (per-method, per-workspace):
//   Tier 1:   1 req/min   (rarely used)
//   Tier 2:  20 req/min   (conversations.list, users.list)
//   Tier 3:  50 req/min   (conversations.history, conversations.replies)
//   Tier 4: 100 req/min   (chat.postMessage)

import { createLogger } from "../../../logger.js";

const log = createLogger("slack-rate-limiter");

/** Known Slack API methods with their tier-based limits */
const METHOD_LIMITS: Record<string, number> = {
  "conversations.list": 20,
  "conversations.history": 50,
  "conversations.replies": 50,
  "chat.postMessage": 100,
  "users.list": 20,
  "auth.test": 100,      // Tier 4
};

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 20; // conservative fallback for unknown methods

interface MethodBucket {
  timestamps: number[];
  limit: number;
}

/**
 * Slack-aware rate limiter.
 *
 * - Per-method sliding-window buckets matching Slack's tier limits
 * - Global 429 backoff: when ANY request receives a 429, ALL methods
 *   pause until the Retry-After period expires
 * - Concurrency serialization: only one in-flight request per method
 *   at a time (prevents burst-then-429 patterns)
 */
export class SlackRateLimiter {
  private buckets = new Map<string, MethodBucket>();
  private globalBackoffUntil = 0;         // epoch ms — all requests wait until this
  private methodLocks = new Map<string, Promise<void>>(); // serialize per method

  /** Acquire a slot for the given Slack API method. Blocks until safe. */
  async acquire(method: string): Promise<void> {
    // Wait for any in-flight request on this method to complete first
    // (serializes per-method concurrency)
    while (this.methodLocks.has(method)) {
      await this.methodLocks.get(method);
    }

    // Wait for global backoff
    await this.waitForBackoff();

    // Wait for per-method bucket
    const bucket = this.getOrCreateBucket(method);
    this.pruneOld(bucket);

    if (bucket.timestamps.length >= bucket.limit) {
      const oldest = bucket.timestamps[0];
      const waitMs = oldest + WINDOW_MS - Date.now() + 50;
      if (waitMs > 0) {
        log.debug(`${method}: bucket full (${bucket.limit}/min), waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        this.pruneOld(bucket);
      }
    }

    bucket.timestamps.push(Date.now());
  }

  /**
   * Create a lock for the given method. Returns a release function.
   * Call this AFTER acquire() and BEFORE the actual API call.
   * Call the returned function when the API call completes (success or failure).
   */
  lock(method: string): () => void {
    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.methodLocks.set(method, lockPromise);

    return () => {
      this.methodLocks.delete(method);
      releaseFn!();
    };
  }

  /**
   * Report a 429 response. Triggers a global backoff that pauses ALL methods.
   * @param retryAfterSeconds — the Retry-After value from the 429 response
   */
  report429(retryAfterSeconds: number): void {
    const backoffUntil = Date.now() + retryAfterSeconds * 1000;
    if (backoffUntil > this.globalBackoffUntil) {
      this.globalBackoffUntil = backoffUntil;
      log.warn(`Global 429 backoff: pausing all Slack requests for ${retryAfterSeconds}s`);
    }
  }

  /** True when any method is at capacity or a global backoff is active */
  get isThrottling(): boolean {
    if (Date.now() < this.globalBackoffUntil) return true;
    for (const [, bucket] of this.buckets) {
      this.pruneOld(bucket);
      if (bucket.timestamps.length >= bucket.limit) return true;
    }
    return false;
  }

  /** Total calls across all methods in the current window */
  get currentLoad(): number {
    let total = 0;
    for (const [, bucket] of this.buckets) {
      this.pruneOld(bucket);
      total += bucket.timestamps.length;
    }
    return total;
  }

  // --- Private ---

  private async waitForBackoff(): Promise<void> {
    const now = Date.now();
    if (now < this.globalBackoffUntil) {
      const waitMs = this.globalBackoffUntil - now;
      log.debug(`Waiting for global backoff: ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }

  private getOrCreateBucket(method: string): MethodBucket {
    let bucket = this.buckets.get(method);
    if (!bucket) {
      bucket = {
        timestamps: [],
        limit: METHOD_LIMITS[method] ?? DEFAULT_LIMIT,
      };
      this.buckets.set(method, bucket);
    }
    return bucket;
  }

  private pruneOld(bucket: MethodBucket): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
      bucket.timestamps.shift();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
