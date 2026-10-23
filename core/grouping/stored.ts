// core/grouping/stored.ts — The v2 grouping as shadow mode last stored it, read back without regrouping (read only)
//
// Shadow mode (shadow.ts) writes each case to v2_cases, each message's case to v2_assignments, and what each message
// is (work, report, telemetry, chatter) to v2_claims. The Overview (docs/overview.md) reads those, so a page load never
// regroups: cases are rebuilt from the stored assignments and the messages they name. A message added since the last
// run is in no case until the next one.

import type BetterSqlite3 from "better-sqlite3";
import { loadGroupingMessages, type LoadedMessage } from "./load.js";
import type { Case, Stream } from "./streams.js";

export interface StoredGrouping {
  messages: LoadedMessage[];
  /** Cases by their stable id, most recently active first, members in time order */
  cases: Case[];
  streams: Stream[];
  /** What each grouped message is, by key (v2_claims kind): work, report, telemetry, chatter */
  kinds: Map<string, string>;
  /** Channels the platform marks as direct messages (threads.platform_meta isDirect) */
  directChannels: Set<string>;
  /** When shadow mode last stored the grouping */
  computedAt: string;
}

function hasTable(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** When shadow mode last stored a grouping, or null when it hasn't: cheap, for knowing when to read it again */
export function storedGroupingAt(db: BetterSqlite3.Database): string | null {
  if (!hasTable(db, "v2_cases")) return null;
  return (db.prepare("SELECT MAX(computed_at) AS at FROM v2_cases").get() as { at: string | null }).at;
}

/** The stored grouping, or null when shadow mode hasn't stored one */
export function loadStoredGrouping(db: BetterSqlite3.Database): StoredGrouping | null {
  const computedAt = storedGroupingAt(db);
  if (!computedAt || !hasTable(db, "v2_assignments")) return null;
  const messages = loadGroupingMessages(db);
  const byKey = new Map(messages.map((m) => [m.key, m]));
  const rows = db.prepare("SELECT id, stream, keys, first_at, last_at FROM v2_cases").all() as Array<{
    id: string; stream: string; keys: string; first_at: string; last_at: string;
  }>;
  const members = new Map<string, Case["members"]>();
  for (const r of db.prepare("SELECT message_key, case_id, via, reasons FROM v2_assignments").all() as Array<{
    message_key: string; case_id: string; via: string | null; reasons: string;
  }>) {
    const m = byKey.get(r.message_key);
    if (!m) continue;
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(r.reasons) as unknown;
      if (Array.isArray(parsed)) reasons = parsed.filter((x): x is string => typeof x === "string");
    } catch { /* stored by shadow mode; an unreadable one only loses its reasons */ }
    const member = { key: r.message_key, at: m.at, via: r.via, viaReason: null, reasons };
    const xs = members.get(r.case_id);
    if (xs) xs.push(member);
    else members.set(r.case_id, [member]);
  }
  const cases: Case[] = [];
  for (const r of rows) {
    const ms = members.get(r.id);
    if (!ms?.length) continue;
    ms.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let keys: string[] = [];
    try {
      const parsed = JSON.parse(r.keys) as unknown;
      if (Array.isArray(parsed)) keys = parsed.filter((x): x is string => typeof x === "string");
    } catch { /* as above */ }
    cases.push({ id: r.id, keys, stream: r.stream, members: ms, first: ms[0].at, last: ms[ms.length - 1].at });
  }
  cases.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  const byStream = new Map<string, Stream>();
  for (const c of cases) {
    const s = byStream.get(c.stream) ?? { key: c.stream, cases: [], messages: 0, last: "" };
    s.cases.push(c.id);
    s.messages += c.members.length;
    if (c.last > s.last) s.last = c.last;
    byStream.set(c.stream, s);
  }
  const kinds = new Map<string, string>();
  if (hasTable(db, "v2_claims")) {
    for (const r of db.prepare("SELECT message_key, value FROM v2_claims WHERE claim = 'kind'").all() as Array<{ message_key: string; value: string }>) {
      kinds.set(r.message_key, r.value);
    }
  }
  const directChannels = new Set<string>();
  for (const r of db.prepare(`
    SELECT DISTINCT channel_id FROM threads WHERE json_valid(platform_meta) AND json_extract(platform_meta, '$.isDirect') = 1
  `).all() as Array<{ channel_id: string }>) directChannels.add(r.channel_id);
  return { messages, cases, streams: [...byStream.values()].sort((a, b) => (a.last < b.last ? 1 : -1)), kinds, directChannels, computedAt };
}
