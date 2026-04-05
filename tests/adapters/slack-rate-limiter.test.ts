// tests/adapters/slack-rate-limiter.test.ts — Tests for Slack per-method rate limiter

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackRateLimiter } from "../../core/adapters/platforms/slack/rate-limiter.js";

describe("SlackRateLimiter", () => {
  let limiter: SlackRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new SlackRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("per-method buckets", () => {
    it("allows requests within the per-method limit", async () => {
      // users.list is Tier 2 = 20 req/min
      for (let i = 0; i < 20; i++) {
        await limiter.acquire("users.list");
      }
      // Should not throw — 20 is exactly the limit
      expect(limiter.isThrottling).toBe(true);
    });

    it("tracks methods independently", async () => {
      // Fill up users.list (Tier 2 = 20)
      for (let i = 0; i < 20; i++) {
        await limiter.acquire("users.list");
      }

      // conversations.history should still be available (separate bucket)
      await limiter.acquire("conversations.history");
      expect(true).toBe(true); // reached here without blocking
    });

    it("blocks when per-method bucket is full", async () => {
      // Fill users.list bucket (20 req/min)
      for (let i = 0; i < 20; i++) {
        await limiter.acquire("users.list");
      }

      // Next acquire should block
      let resolved = false;
      const promise = limiter.acquire("users.list").then(() => {
        resolved = true;
      });

      // Advance time past the window
      await vi.advanceTimersByTimeAsync(61_000);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe("global 429 backoff", () => {
    it("pauses all methods when a 429 is reported", async () => {
      limiter.report429(5); // 5-second backoff

      let resolved = false;
      const promise = limiter.acquire("conversations.history").then(() => {
        resolved = true;
      });

      // Should still be waiting at 4s
      await vi.advanceTimersByTimeAsync(4_000);
      expect(resolved).toBe(false);

      // Should resolve after 5s
      await vi.advanceTimersByTimeAsync(1_500);
      await promise;
      expect(resolved).toBe(true);
    });

    it("extends backoff if a new 429 arrives during existing backoff", async () => {
      limiter.report429(3);

      await vi.advanceTimersByTimeAsync(1_000);

      // New 429 with longer retry
      limiter.report429(5);

      let resolved = false;
      const promise = limiter.acquire("users.list").then(() => {
        resolved = true;
      });

      // Original 3s would have expired, but the new 5s hasn't
      await vi.advanceTimersByTimeAsync(3_500);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe("method locking (serialization)", () => {
    it("serializes concurrent calls to the same method", async () => {
      const order: string[] = [];

      // First call acquires and locks
      await limiter.acquire("conversations.history");
      const release1 = limiter.lock("conversations.history");
      order.push("call1-start");

      // Second call should wait for lock
      let call2Done = false;
      const call2 = limiter.acquire("conversations.history").then(() => {
        call2Done = true;
        order.push("call2-start");
      });

      // call2 should be blocked
      await vi.advanceTimersByTimeAsync(10);
      expect(call2Done).toBe(false);

      // Release first call
      release1();
      await call2;
      expect(call2Done).toBe(true);
      expect(order).toEqual(["call1-start", "call2-start"]);
    });

    it("does not block different methods", async () => {
      await limiter.acquire("conversations.history");
      const release1 = limiter.lock("conversations.history");

      // Different method should not be blocked
      await limiter.acquire("users.list");
      const release2 = limiter.lock("users.list");

      // Both should have proceeded
      release1();
      release2();
    });
  });

  describe("isThrottling", () => {
    it("returns false when no limits are reached", () => {
      expect(limiter.isThrottling).toBe(false);
    });

    it("returns true during global backoff", () => {
      limiter.report429(10);
      expect(limiter.isThrottling).toBe(true);
    });

    it("returns true when any method bucket is full", async () => {
      // Fill users.list (20 req/min)
      for (let i = 0; i < 20; i++) {
        await limiter.acquire("users.list");
      }
      expect(limiter.isThrottling).toBe(true);
    });
  });

  describe("currentLoad", () => {
    it("returns 0 with no calls", () => {
      expect(limiter.currentLoad).toBe(0);
    });

    it("counts calls across all methods", async () => {
      await limiter.acquire("conversations.history");
      await limiter.acquire("conversations.history");
      await limiter.acquire("users.list");

      expect(limiter.currentLoad).toBe(3);
    });

    it("prunes old entries", async () => {
      await limiter.acquire("conversations.history");
      await limiter.acquire("users.list");

      expect(limiter.currentLoad).toBe(2);

      // Advance past the window
      await vi.advanceTimersByTimeAsync(61_000);
      expect(limiter.currentLoad).toBe(0);
    });
  });
});
