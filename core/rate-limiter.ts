// core/rate-limiter.ts — Sliding-window rate limiter for API calls

import { createLogger } from "./logger.js";

const log = createLogger("rate-limiter");

export interface RateLimiterConfig {
  /** Max calls allowed per window */
  maxPerMinute: number;
  /** Name for logging and keying */
  name: string;
  /** Human-readable label for UI (e.g. "LLM", "Slack"). Defaults to capitalized name. */
  displayName?: string;
}

/**
 * Sliding-window rate limiter.
 * Tracks timestamps of recent calls and delays when the limit is reached.
 */
export class RateLimiter {
  private readonly name: string;
  readonly displayName: string;
  private readonly maxPerMinute: number;
  private readonly windowMs = 60_000; // 1 minute
  private readonly timestamps: number[] = [];

  constructor(config: RateLimiterConfig) {
    this.name = config.name;
    this.displayName = config.displayName ?? config.name.charAt(0).toUpperCase() + config.name.slice(1);
    this.maxPerMinute = config.maxPerMinute;
    log.info(`Rate limiter "${this.name}": ${this.maxPerMinute} req/min`);
  }

  /**
   * Wait until a slot is available, then record the call.
   * Call this before making each API request.
   */
  async acquire(): Promise<void> {
    this.pruneOld();

    if (this.timestamps.length < this.maxPerMinute) {
      this.timestamps.push(Date.now());
      return;
    }

    // Window is full — wait until the oldest call expires
    const oldest = this.timestamps[0];
    const waitMs = oldest + this.windowMs - Date.now() + 50; // +50ms buffer

    if (waitMs > 0) {
      log.debug(`${this.name}: rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.pruneOld();
    }

    this.timestamps.push(Date.now());
  }

  /** Remove timestamps older than the window */
  private pruneOld(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  /** Current number of calls in the window */
  get currentLoad(): number {
    this.pruneOld();
    return this.timestamps.length;
  }

  /** True when the window is full and the next acquire() would block */
  get isThrottling(): boolean {
    this.pruneOld();
    return this.timestamps.length >= this.maxPerMinute;
  }

  get limit(): number {
    return this.maxPerMinute;
  }
}

/** Registry of named rate limiters */
const limiters = new Map<string, RateLimiter>();

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const limiter = new RateLimiter(config);
  limiters.set(config.name, limiter);
  return limiter;
}

export function getRateLimiter(name: string): RateLimiter | undefined {
  return limiters.get(name);
}
