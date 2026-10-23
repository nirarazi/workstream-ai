// core/grouping/overview.ts — The Overview: is anything off, across every stream of work? (read only)
//
// The first version of docs/overview.md §5. From the grouping shadow mode stored (stored.ts), never regrouping, it
// answers "is anything off?" for the whole business or one area:
//   - needs you: the asks Needs me by case holds (inbox.ts), ranked by what each holds up (rank.ts);
//   - stuck or noisy: streams judged against their own pace;
//   - finished in the last seven days;
//   - what changed since the viewer last looked;
//   - one line for every other stream with a message in the last 30 days.
// Movement is a case's status changing, in the messages that are work (reports and telemetry never count). A stream is
// stuck when a case in it waits on someone (blocked, or a decision), other than an ask already in front of the operator
// or one they've dealt with (snoozed, dismissed, acted on) or that was handed on, and its latest movement is older
// than its stuck line, however old (a case blocked for months is still stuck): three times its median gap between movements and at
// least two days, or seven days while it has fewer than three. A case merely in progress and quiet is a slow stream's
// normal, not stuck. A case's first message counts as movement, so a stream that keeps opening new cases is moving. It's noisy with ten or more
// messages that are work or chatter in the last seven days and no movement in them. An area is the channel most of a
// stream's messages are in; direct messages are one area. All placeholders for the trial (open question 1).

import type BetterSqlite3 from "better-sqlite3";
import { findAsks } from "./asks.js";
import { ASKS, isOperator, loadInboxState, v2Inbox, type V2Entry } from "./inbox.js";
import { actorOfHandle, loadActorNames, type LoadedMessage } from "./load.js";
import { ago, rankNeedsYou, rankReason } from "./rank.js";
import { loadStoredGrouping, storedGroupingAt, type StoredGrouping } from "./stored.js";
import type { Case } from "./streams.js";

const DAY = 86_400_000;
const FINISHED_DAYS = 7;
const ACTIVE_DAYS = 30;
const NOISY_DAYS = 7;
const NOISY_MESSAGES = 10;
const MIN_STUCK_DAYS = 2;
const NEW_STREAM_STUCK_DAYS = 7;
/** Open blocks older than this aren't waiting any more: they're stale (as the lab's wait-for graph) */
const BLOCKS_DAYS = 14;
/** The most rows a section lists; the rest are counted */
const MAX_ROWS = 25;
const DIRECT_AREA = "direct";
/** Messages that are routine output, never movement and never noise */
const ROUTINE = new Set(["report", "telemetry"]);

export interface OverviewArea {
  id: string;
  label: string;
  /** Streams with a message in the last 30 days */
  active: number;
  /** Of those, stuck or noisy */
  off: number;
}

export interface OverviewRow {
  caseId: string | null;
  stream: string;
  streamLabel: string;
  area: string;
  title: string;
  /** Why it's here, in words */
  detail: string;
  at: string;
}

export interface Overview {
  /** When shadow mode last stored the grouping this reads, or null when it hasn't yet */
  groupedAt: string | null;
  now: string;
  since: string;
  area: string | null;
  areas: OverviewArea[];
  changes: { finished: number; stuck: number; new: number; handedToYou: number };
  needsYou: { rows: OverviewRow[]; total: number };
  stuck: { rows: Array<OverviewRow & { why: Array<"stuck" | "noisy"> }>; total: number };
  finished: { rows: OverviewRow[]; total: number };
  /** Active streams shown in no section above */
  movingNormally: number;
}

export interface OverviewInput {
  grouping: StoredGrouping;
  /** Needs me by case */
  needsYou: V2Entry[];
  /** Cases Needs me by case holds back: snoozed, dismissed or acted on by the operator, handed off, or noise */
  held: ReadonlySet<string>;
  ranked: ReturnType<typeof rankNeedsYou>;
  actorName: (id: string) => string;
}

/** What a stream is called: a subject by its name, a channel's by the channel ("#ops"), others by their key */
export function streamLabel(key: string, channelNames: ReadonlyMap<string, string>): string {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "subject") return value;
  if (kind === "project") return `${value} tickets`;
  if (kind === "channel") return channelNames.has(value) ? `#${channelNames.get(value)}` : "a channel";
  if (kind === "records") return `${value} records`;
  return key;
}

/** A message's words for a one-line title: whitespace joined, cut short */
function titleOf(m: LoadedMessage | undefined, n = 120): string {
  const text = (m?.text ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** A case's movements (status changes in its messages that are work), and its status after the last */
export function movementsOf(c: Case, messages: ReadonlyMap<string, LoadedMessage>, kinds: ReadonlyMap<string, string>): { at: string[]; status: string | null } {
  const at: string[] = [];
  let status: string | null = null;
  for (const member of c.members) {
    const m = messages.get(member.key);
    if (!m || !m.status || m.status === "noise" || ROUTINE.has(kinds.get(m.key) ?? "")) continue;
    if (m.status !== status) at.push(m.at);
    status = m.status;
  }
  return { at, status };
}

/** The day count past which a stream with these movements is stuck */
export function stuckLineMs(movements: readonly string[]): number {
  if (movements.length < 3) return NEW_STREAM_STUCK_DAYS * DAY;
  const t = movements.map((x) => Date.parse(x)).sort((a, b) => a - b);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  return Math.max(MIN_STUCK_DAYS * DAY, 3 * median(gaps));
}

/** Pure. The Overview for one lens: the whole business (area null) or one area, as of `now`, changes since `since` */
export function buildOverview(input: OverviewInput, opts: { now: string; since: string; area: string | null }): Overview {
  const { grouping: g } = input;
  const now = Date.parse(opts.now);
  const messages = new Map(g.messages.map((m) => [m.key, m]));
  const channelNames = new Map(g.messages.filter((m) => m.channelId && m.channelName).map((m) => [m.channelId!, m.channelName]));
  const cases = new Map(g.cases.map((c) => [c.id, c]));
  // Already in front of the operator, or already dealt with by them or handed on: never "stuck" as well
  const settled = new Set([...input.needsYou.map((e) => e.caseId), ...input.held]);

  // Each stream's area: the channel most of its messages are in, direct messages together
  const areaOf = new Map<string, string>();
  for (const s of g.streams) {
    const counts = new Map<string, number>();
    for (const id of s.cases) {
      for (const member of cases.get(id)!.members) {
        const ch = messages.get(member.key)?.channelId ?? "?";
        const area = g.directChannels.has(ch) ? DIRECT_AREA : `channel:${ch}`;
        counts.set(area, (counts.get(area) ?? 0) + 1);
      }
    }
    areaOf.set(s.key, [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "channel:?");
  }
  const areaLabel = (id: string) => id === DIRECT_AREA ? "Direct messages" : streamLabel(id, channelNames);
  const inLens = (stream: string) => !opts.area || areaOf.get(stream) === opts.area;
  const label = (stream: string) => streamLabel(stream, channelNames);

  // Each stream's pace and state
  type StreamState = { key: string; active: boolean; stuck: boolean; stuckSince: number; noisy: boolean; lastMove: number; openCase: Case | null };
  const states: StreamState[] = [];
  const finished: OverviewRow[] = [];
  let newCases = 0;
  // Finished since the last look, however long ago that was (the list itself is the last seven days)
  let finishedSince = 0;
  for (const s of g.streams) {
    const moves: string[] = [];
    let openCase: Case | null = null;
    // The latest case waiting on someone (blocked, or a decision) that isn't already in front of the operator
    let waitingCase: Case | null = null;
    let recent = 0;
    let recentMove = false;
    for (const id of s.cases) {
      const c = cases.get(id)!;
      const { at, status } = movementsOf(c, messages, g.kinds);
      moves.push(...at);
      if (status && status !== "completed" && (!openCase || c.last > openCase.last)) openCase = c;
      if (status && ASKS.has(status) && !settled.has(c.id) && (!waitingCase || c.last > waitingCase.last)) waitingCase = c;
      const last = at[at.length - 1];
      if (status === "completed" && last && now - Date.parse(last) <= FINISHED_DAYS * DAY && inLens(s.key)) {
        finished.push({ caseId: c.id, stream: s.key, streamLabel: label(s.key), area: areaOf.get(s.key)!, title: titleOf(messages.get(c.members[0].key)), detail: `finished ${ago(last, opts.now)} ago`, at: last });
      }
      if (status === "completed" && last && last > opts.since && inLens(s.key)) finishedSince++;
      if (c.first > opts.since && inLens(s.key)) newCases++;
      for (const member of c.members) {
        const m = messages.get(member.key);
        if (!m || now - Date.parse(m.at) > NOISY_DAYS * DAY || ROUTINE.has(g.kinds.get(m.key) ?? "") || m.status === "noise") continue;
        recent++;
      }
      if (at.some((x) => now - Date.parse(x) <= NOISY_DAYS * DAY)) recentMove = true;
    }
    moves.sort();
    const lastMove = moves.length ? Date.parse(moves[moves.length - 1]) : Date.parse(s.last);
    const active = now - Date.parse(s.last) <= ACTIVE_DAYS * DAY;
    const line = stuckLineMs(moves);
    // Waiting on someone for longer than its pace: stuck. A case merely in progress and quiet is a slow stream's normal
    const stuck = active && waitingCase !== null && now - lastMove > line;
    states.push({ key: s.key, active, stuck, stuckSince: lastMove + line, noisy: active && recent >= NOISY_MESSAGES && !recentMove, lastMove, openCase: stuck ? waitingCase : openCase });
  }

  // Needs you, in rank order
  const needsRows: OverviewRow[] = [];
  const shownStreams = new Set<string>();
  let handedToYou = 0;
  for (const r of input.ranked) {
    const c = cases.get(r.entry.caseId);
    const stream = c?.stream ?? "";
    if (opts.area && (!c || !inLens(stream))) continue;
    if (c) shownStreams.add(stream);
    if (r.waitingSince > opts.since) handedToYou++;
    needsRows.push({
      caseId: c ? c.id : null, stream, streamLabel: c ? label(stream) : "", area: c ? areaOf.get(stream)! : "",
      title: titleOf(r.entry.ask), detail: rankReason(r, opts.now, input.actorName), at: r.entry.ask.at,
    });
  }

  const stuckRows: Array<OverviewRow & { why: Array<"stuck" | "noisy"> }> = [];
  let becameStuck = 0;
  for (const st of states) {
    if (!inLens(st.key) || (!st.stuck && !st.noisy)) continue;
    shownStreams.add(st.key);
    if (st.stuck && st.stuckSince > Date.parse(opts.since)) becameStuck++;
    const why: Array<"stuck" | "noisy"> = [...(st.stuck ? ["stuck" as const] : []), ...(st.noisy ? ["noisy" as const] : [])];
    const c = st.openCase;
    const detail = st.stuck ? `no movement for ${ago(new Date(st.lastMove).toISOString(), opts.now)}` : "busy this week, no movement";
    stuckRows.push({
      caseId: c?.id ?? null, stream: st.key, streamLabel: label(st.key), area: areaOf.get(st.key)!,
      title: c ? titleOf(messages.get(c.members[0].key)) : "", detail: st.stuck && st.noisy ? `${detail}, and busy this week` : detail,
      at: new Date(st.lastMove).toISOString(), why,
    });
  }
  // Longest without movement first
  stuckRows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  finished.sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const f of finished) shownStreams.add(f.stream);

  const areas = new Map<string, OverviewArea>();
  for (const st of states) {
    if (!st.active) continue;
    const id = areaOf.get(st.key)!;
    const a = areas.get(id) ?? { id, label: areaLabel(id), active: 0, off: 0 };
    a.active++;
    if (st.stuck || st.noisy) a.off++;
    areas.set(id, a);
  }

  return {
    groupedAt: g.computedAt,
    now: opts.now,
    since: opts.since,
    area: opts.area,
    areas: [...areas.values()].sort((a, b) => b.active - a.active || (a.label < b.label ? -1 : 1)),
    changes: { finished: finishedSince, stuck: becameStuck, new: newCases, handedToYou },
    needsYou: { rows: needsRows.slice(0, MAX_ROWS), total: needsRows.length },
    stuck: { rows: stuckRows.slice(0, MAX_ROWS), total: stuckRows.length },
    finished: { rows: finished.slice(0, MAX_ROWS), total: finished.length },
    movingNormally: states.filter((st) => st.active && inLens(st.key) && !shownStreams.has(st.key)).length,
  };
}

/** The empty Overview, for before shadow mode has stored a grouping */
function emptyOverview(opts: { now: string; since: string; area: string | null }): Overview {
  return {
    groupedAt: null, ...opts, areas: [], changes: { finished: 0, stuck: 0, new: 0, handedToYou: 0 },
    needsYou: { rows: [], total: 0 }, stuck: { rows: [], total: 0 }, finished: { rows: [], total: 0 }, movingNormally: 0,
  };
}

/**
 * Reads what the Overview needs from the database: the stored grouping, Needs me by case and its ranking. Reads only.
 * Exported for the blocked-on-me report, which ranks the same way.
 */
export function loadOverviewInput(
  db: BetterSqlite3.Database,
  opts: { operatorNames: readonly string[]; handoff: number; now: string },
): OverviewInput | null {
  const grouping = loadStoredGrouping(db);
  if (!grouping) return null;
  const messages = new Map(grouping.messages.map((m) => [m.key, m]));
  const { events, items, escalations } = loadInboxState(db, grouping.cases, grouping.messages);
  const inbox = v2Inbox(grouping.cases, messages, events, items, escalations, opts);
  const actors = loadActorNames(db);
  const caseOf = new Map<string, { cluster: string | null }>();
  for (const c of grouping.cases) for (const m of c.members) caseOf.set(m.key, { cluster: c.id });
  const asks = findAsks(grouping.messages, caseOf, new Map([...actors].map(([id, name]) => [name.trim().toLowerCase(), id])), actorOfHandle(actors));
  const operatorActors = new Set([...actors].filter(([id, name]) => isOperator(opts.operatorNames, id, name)).map(([id]) => id));
  const since = new Date(Date.parse(opts.now) - BLOCKS_DAYS * DAY).toISOString();
  const ranked = rankNeedsYou(inbox.entries, new Map(grouping.cases.map((c) => [c.id, c])), messages, asks, { operatorNames: opts.operatorNames, operatorActors, since });
  return { grouping, needsYou: inbox.entries, held: new Set(inbox.held.keys()), ranked, actorName: (id) => actors.get(id) ?? id };
}

const RECHECK_MS = 30_000;

/**
 * The engine's Overview: reads the stored grouping again when shadow mode stores a new one, and the operator's state on
 * items (snoozes, dismissals, actions) at most every 30 seconds
 */
export class OverviewService {
  private input: OverviewInput | null = null;
  private groupedAt: string | null = null;
  private readAt = 0;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly operator: () => { operatorNames: readonly string[]; handoff: number },
  ) {}

  get(opts: { since: string; area: string | null; now?: string }): Overview {
    const now = opts.now ?? new Date().toISOString();
    const t = Date.now();
    if (!this.input || t - this.readAt >= RECHECK_MS || storedGroupingAt(this.db) !== this.groupedAt) {
      this.groupedAt = storedGroupingAt(this.db);
      this.input = loadOverviewInput(this.db, { ...this.operator(), now });
      this.readAt = t;
    }
    const lens = { now, since: opts.since, area: opts.area };
    return this.input ? buildOverview(this.input, lens) : emptyOverview(lens);
  }
}
