// tests/lib/looks.test.ts — when the viewer last looked, kept through a visit and read again after a long gap

import { describe, it, expect } from "vitest";
import { lookTracker } from "../../src/lib/looks.js";

describe("lookTracker", () => {
  it("keeps one starting point through a visit, and reads the stored looks again after the gap", () => {
    const stored: Record<string, string> = { "": "2026-10-19T09:00:00.000Z" };
    const looks = lookTracker(() => ({ ...stored }), 3_600_000);
    const t0 = Date.parse("2026-10-20T09:00:00.000Z");
    expect(looks.since("", t0)).toBe("2026-10-19T09:00:00.000Z");
    // This look is stored; coming back within the hour still shows the same changes
    stored[""] = "2026-10-20T09:00:00.000Z";
    expect(looks.since("", t0 + 30 * 60_000)).toBe("2026-10-19T09:00:00.000Z");
    expect(looks.since("channel:C0OPS", t0 + 30 * 60_000)).toBeNull();
    // The next morning, from the last look
    expect(looks.since("", t0 + 24 * 3_600_000)).toBe("2026-10-20T09:00:00.000Z");
  });
});
