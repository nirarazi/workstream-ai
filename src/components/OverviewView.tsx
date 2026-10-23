// src/components/OverviewView.tsx — The Overview: is anything off, across every stream of work? (read only)
//
// docs/overview.md §5. One page for the whole business, or one area through a lens: what changed since you last
// looked, what needs you, what's stuck or noisy, what finished this week, and one line for everything moving normally.
// Its only state is when you last looked, per lens, kept in this browser; without it, the last 24 hours. Calm by
// design: green and amber, never red, and no counts you can't act on.

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { fetchOverview, type Overview, type OverviewRow } from "../lib/api";

const LOOKED_KEY = "workstream-overview-looked";
const REFRESH_MS = 60_000;
const WHOLE = "";

/** When the viewer last looked, by lens; storage can be missing or refuse, which only loses the memory */
function readLooked(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(LOOKED_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeLooked(lens: string, at: string): void {
  try {
    localStorage.setItem(LOOKED_KEY, JSON.stringify({ ...readLooked(), [lens]: at }));
  } catch { /* not remembered: next time falls back to the last 24 hours */ }
}

function sinceLabel(since: string, now: string): string {
  const hours = (Date.parse(now) - Date.parse(since)) / 3_600_000;
  if (!Number.isFinite(hours)) return "recently";
  if (hours < 1) return "under an hour ago";
  if (hours < 20) return `${Math.round(hours)} hours ago`;
  if (hours < 40) return "yesterday";
  return `${Math.round(hours / 24)} days ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function Section({ title, total, rows, empty }: { title: string; total: number; rows: OverviewRow[]; empty: string }): JSX.Element {
  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        {title}
        {total > 0 && <span className="ml-1.5 font-normal text-gray-600">({total})</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-600">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-800/60 border border-gray-800 rounded">
          {rows.map((r, i) => (
            <li key={`${r.caseId ?? r.stream}-${i}`} className="px-3 py-2">
              <div className="flex items-baseline gap-2 min-w-0">
                {r.streamLabel && <span className="shrink-0 text-xs text-gray-500">{r.streamLabel}</span>}
                <span className="truncate text-sm text-gray-200" title={r.title}>{r.title || "(no text)"}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">{r.detail}</div>
            </li>
          ))}
          {total > rows.length && <li className="px-3 py-2 text-xs text-gray-600">and {total - rows.length} more</li>}
        </ul>
      )}
    </section>
  );
}

export default function OverviewView(): JSX.Element {
  const [lens, setLens] = useState<string>(WHOLE);
  // When each lens was last looked at before this visit: read once, so a refresh or switching back keeps showing the
  // same changes, while the visit itself is remembered for next time
  const looked = useRef<Record<string, string>>(readLooked());
  const since = looked.current[lens] ?? null;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Opening a lens counts as looking at it
  useEffect(() => {
    writeLooked(lens, new Date().toISOString());
  }, [lens]);

  const load = useCallback(async () => {
    try {
      setData(await fetchOverview(since, lens || null));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The engine didn't answer");
    }
  }, [since, lens]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error && !data) return <p className="text-sm text-gray-500">Couldn't load the overview: {error}</p>;
  if (!data) return <p className="text-sm text-gray-600">Loading…</p>;
  if (!data.groupedAt) {
    return <p className="text-sm text-gray-500">Nothing to show yet: the engine groups messages into streams after it polls.</p>;
  }

  const c = data.changes;
  const changed = [
    c.finished && `${c.finished} finished`,
    c.stuck && `${c.stuck} got stuck`,
    c.new && `${c.new} new`,
    c.handedToYou && `${plural(c.handedToYou, "ask")} for you`,
  ].filter(Boolean);
  const calm = data.needsYou.total === 0 && data.stuck.total === 0;

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-gray-300 mb-1">
        {calm
          ? "Nothing needs you, and nothing is stuck."
          : [data.needsYou.total && `${plural(data.needsYou.total, "thing")} need${data.needsYou.total === 1 ? "s" : ""} you`,
             data.stuck.total && `${plural(data.stuck.total, "stream")} stuck or noisy`].filter(Boolean).join("; ") + "."}
      </p>
      <p className="text-xs text-gray-500 mb-4">
        Since you last looked ({sinceLabel(data.since, data.now)}): {changed.length ? changed.join(" · ") : "nothing changed"}
      </p>

      <nav className="flex flex-wrap items-center gap-1.5 mb-6" aria-label="Lens">
        {[{ id: WHOLE, label: "Whole business", off: data.areas.some((a) => a.off > 0), active: 0 }, ...data.areas.slice(0, 12).map((a) => ({ id: a.id, label: a.label, off: a.off > 0, active: a.active }))]
          .map((a) => (
            <button
              key={a.id || "whole"}
              onClick={() => setLens(a.id)}
              title={a.id ? `${plural(a.active, "active stream")}${a.off ? `, ${a.off} stuck or noisy` : ""}` : undefined}
              className={`cursor-pointer inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                lens === a.id ? "border-cyan-600 text-gray-200" : "border-gray-800 text-gray-500 hover:text-gray-300"
              }`}
            >
              <span aria-hidden className={a.off ? "text-amber-500" : "text-green-500"}>{a.off ? "◐" : "●"}</span>
              {a.label}
            </button>
          ))}
      </nav>

      <Section title="Needs you" total={data.needsYou.total} rows={data.needsYou.rows} empty="Nothing is waiting on you." />
      <Section title="Stuck or noisy" total={data.stuck.total} rows={data.stuck.rows} empty="Every stream is moving at its usual pace." />
      <Section title="Finished, last 7 days" total={data.finished.total} rows={data.finished.rows} empty="Nothing finished this week." />

      <p className="text-xs text-gray-500">
        {plural(data.movingNormally, "other stream")} moving normally.
        <span className="ml-2 text-gray-600">Grouped {sinceLabel(data.groupedAt, data.now)}.</span>
      </p>
    </div>
  );
}
