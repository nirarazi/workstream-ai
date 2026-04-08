// tests/lib/time.test.ts — Tests for timeAgo

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo } from "../../src/lib/time.js";

describe("timeAgo", () => {
  beforeEach(() => {
    // Fix "now" to a known moment: 2026-04-01T12:00:00.000Z
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Xs ago for a timestamp seconds in the past", () => {
    const tenSecondsAgo = new Date("2026-04-01T11:59:50.000Z").toISOString();
    expect(timeAgo(tenSecondsAgo)).toBe("10s ago");
  });

  it("returns Xm ago for a timestamp minutes in the past", () => {
    const fiveMinutesAgo = new Date("2026-04-01T11:55:00.000Z").toISOString();
    expect(timeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  it("returns Xh ago for a timestamp hours in the past", () => {
    const threeHoursAgo = new Date("2026-04-01T09:00:00.000Z").toISOString();
    expect(timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("returns Xd ago for a timestamp days in the past", () => {
    const twoDaysAgo = new Date("2026-03-30T12:00:00.000Z").toISOString();
    expect(timeAgo(twoDaysAgo)).toBe("2d ago");
  });

  it("returns Xmo ago for a timestamp months in the past", () => {
    // 90 days ago = 3 months (at 30-day rounding)
    const threeMonthsAgo = new Date("2026-01-01T12:00:00.000Z").toISOString();
    expect(timeAgo(threeMonthsAgo)).toBe("3mo ago");
  });

  it("returns 'just now' for a future timestamp", () => {
    const future = new Date("2026-04-01T13:00:00.000Z").toISOString();
    expect(timeAgo(future)).toBe("just now");
  });

  it("handles Slack epoch timestamp (e.g. '1711234567.123456')", () => {
    // 1711234567 = 2024-03-23T19:16:07Z — well in the past from our fixed "now"
    const result = timeAgo("1711234567.123456");
    // Should be a valid relative time string, NOT empty or NaN
    expect(result).toBeTruthy();
    expect(result).not.toContain("NaN");
    // It's roughly 1 year+ ago, so should contain "y ago" or "mo ago"
    expect(result).toMatch(/\d+(mo|y) ago/);
  });

  it("returns empty string for invalid string", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(timeAgo("")).toBe("");
  });

  it("returns 0s ago for a timestamp exactly equal to now", () => {
    const now = new Date("2026-04-01T12:00:00.000Z").toISOString();
    expect(timeAgo(now)).toBe("0s ago");
  });
});
