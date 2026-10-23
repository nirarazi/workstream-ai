// src/lib/looks.ts — When the viewer last looked at each Overview lens, before this look
//
// The Overview shows what changed since the viewer last looked. A look's starting point is read from the stored looks
// once and kept while the viewer comes and goes (a refresh, another lens, another tab), so the same changes stay on
// screen; when that copy is older than `maxAgeMs` (a window left open overnight), the next look reads the stored looks
// again, so a new morning starts from the last look, not from when the app was opened.

export const LOOK_MAX_AGE_MS = 3_600_000;

export function lookTracker(read: () => Record<string, string>, maxAgeMs = LOOK_MAX_AGE_MS) {
  let snapshot: Record<string, string> | null = null;
  let takenAt = 0;
  return {
    /** When `lens` was last looked at before this look, or null when it never was */
    since(lens: string, now: number): string | null {
      if (!snapshot || now - takenAt > maxAgeMs) {
        snapshot = read();
        takenAt = now;
      }
      return snapshot[lens] ?? null;
    },
  };
}
