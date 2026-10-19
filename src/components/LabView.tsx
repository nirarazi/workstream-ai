// src/components/LabView.tsx — The grouping lab: streams, their cases, and a case drawn as a graph
//
// A development view of the v2 grouping (the engine serves it with WORKSTREAM_LAB=true). A case is drawn on a
// timeline: time left to right, one lane per thread, each message a node coloured by who sent it, and an edge from the
// message whose evidence drew it in, coloured by that evidence. Clicking a node shows the message and why it joined.

import { useEffect, useMemo, useState, type JSX } from "react";
import { fetchLabCase, fetchLabStream, fetchLabStreams, type LabCase, type LabCaseSummary, type LabNode, type LabStream } from "../lib/api";

const EDGE_CLASSES: Record<string, string> = {
  thread: "stroke-gray-500",
  sameKey: "stroke-cyan-500",
  namedSubject: "stroke-cyan-700",
  exchange: "stroke-amber-500",
  followUp: "stroke-green-500",
  continuation: "stroke-purple-400",
  nearCopy: "stroke-red-400",
  promoted: "stroke-green-300",
  operator: "stroke-red-500",
};

const NODE_CLASSES: Record<string, string> = {
  human: "fill-cyan-500",
  agent: "fill-purple-400",
  notification: "fill-gray-500",
  unknown: "fill-gray-400",
};

/** The traffic-light status colours (docs/theming.md) */
const STATUS_CLASSES: Record<string, string> = {
  blocked_on_human: "bg-red-900/60 text-red-200",
  needs_decision: "bg-red-900/60 text-red-200",
  in_progress: "bg-amber-900/50 text-amber-200",
  completed: "bg-green-900/50 text-green-200",
  noise: "bg-gray-800 text-gray-400",
};
const STATUS_LABELS: Record<string, string> = {
  blocked_on_human: "Blocked",
  needs_decision: "Decision",
  in_progress: "In progress",
  completed: "Done",
  noise: "Noise",
};

const LANE = 34;
const STEP = 46;
const PAD = 28;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function streamLabel(key: string): string {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (key.startsWith("#")) return key;
  return kind === "subject" ? value : kind === "project" ? `${value} tickets` : kind === "channel" ? `#${value}` : key;
}

function CaseGraph({ data, selected, onSelect }: { data: LabCase; selected: string | null; onSelect: (key: string) => void }): JSX.Element {
  const layout = useMemo(() => {
    // A lane per conversation with replies; posts on their own share the first lane, so the graph stays compact
    const replies = new Map<string, number>();
    for (const n of data.nodes) replies.set(n.threadId, (replies.get(n.threadId) ?? 0) + 1);
    const lanes = new Map<string, number>([["", 0]]);
    const laneOf = (n: LabNode) => ((replies.get(n.threadId) ?? 0) > 1 ? n.threadId : "");
    for (const n of data.nodes) if (!lanes.has(laneOf(n))) lanes.set(laneOf(n), lanes.size);
    const at = new Map(data.nodes.map((n, i) => [n.key, { x: PAD + i * STEP, y: PAD + (lanes.get(laneOf(n)) ?? 0) * LANE }]));
    return { lanes: lanes.size, at };
  }, [data]);
  const width = PAD * 2 + Math.max(0, data.nodes.length - 1) * STEP;
  const height = PAD * 2 + Math.max(0, layout.lanes - 1) * LANE;

  return (
    <div className="overflow-auto border border-gray-800 rounded bg-gray-950">
      <svg width={width} height={height} role="img" aria-label={`Case ${data.case.id}: ${data.nodes.length} messages`}>
        {data.edges.map((e) => {
          const a = layout.at.get(e.from);
          const b = layout.at.get(e.to);
          if (!a || !b) return null;
          const mid = (a.x + b.x) / 2;
          const lift = a.y === b.y ? Math.min(40, (b.x - a.x) / 3) : 0;
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={`M ${a.x} ${a.y} C ${mid} ${a.y - lift}, ${mid} ${b.y - lift}, ${b.x} ${b.y}`}
              className={`${EDGE_CLASSES[e.reason] ?? "stroke-gray-600"} fill-none`}
              strokeWidth={1.5}
              opacity={0.8}
            >
              <title>{e.reason}</title>
            </path>
          );
        })}
        {data.nodes.map((n) => {
          const p = layout.at.get(n.key)!;
          return (
            <circle
              key={n.key}
              cx={p.x}
              cy={p.y}
              r={selected === n.key ? 8 : 6}
              className={`${NODE_CLASSES[n.senderKind] ?? "fill-gray-400"} cursor-pointer ${selected === n.key ? "stroke-gray-200" : "stroke-gray-900"}`}
              strokeWidth={2}
              onClick={() => onSelect(n.key)}
            >
              <title>{`${n.sender} · ${when(n.at)}`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function NodeDetail({ node }: { node: LabNode }): JSX.Element {
  return (
    <div className="mt-3 rounded border border-gray-800 bg-gray-900 p-3 text-sm">
      <div className="flex flex-wrap gap-x-3 text-xs text-gray-400">
        <span className="text-gray-200 font-medium">{node.sender}</span>
        <span>{node.senderKind}</span>
        <span>#{node.channel}</span>
        <span>{when(node.at)}</span>
        <span>{node.topLevel ? "top-level" : "in a thread"}</span>
        {node.about && <span className="text-cyan-400">about {node.about}</span>}
      </div>
      <div className="mt-2 text-xs text-gray-400">Joined by: {node.reasons.join(" · ")}</div>
      <p className="mt-2 whitespace-pre-wrap text-gray-300">{node.text}</p>
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      {Object.entries(EDGE_CLASSES).map(([reason, cls]) => (
        <span key={reason} className="flex items-center gap-1">
          <svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" className={cls} strokeWidth={2} /></svg>
          {reason}
        </span>
      ))}
      {Object.entries(NODE_CLASSES).map(([kind, cls]) => (
        <span key={kind} className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" className={cls} /></svg>
          {kind}
        </span>
      ))}
    </div>
  );
}

export default function LabView(): JSX.Element {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "waiting" | "needsYou">("all");
  const [streams, setStreams] = useState<LabStream[]>([]);
  const [total, setTotal] = useState(0);
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const [cases, setCases] = useState<LabCaseSummary[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [graph, setGraph] = useState<LabCase | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchLabStreams(q, only).then((r) => { setStreams(r.streams); setTotal(r.total); setError(null); }).catch((e) => setError(String(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [q, only]);

  useEffect(() => {
    if (!streamKey) return;
    setCases([]);
    setCaseId(null);
    fetchLabStream(streamKey).then((r) => setCases(r.cases)).catch((e) => setError(String(e)));
  }, [streamKey]);

  useEffect(() => {
    if (!caseId) { setGraph(null); return; }
    setSelected(null);
    fetchLabCase(caseId).then(setGraph).catch((e) => setError(String(e)));
  }, [caseId]);

  const node = graph?.nodes.find((n) => n.key === selected) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 border-r border-gray-800 flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-800">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter streams"
            aria-label="Filter streams"
            className="w-full rounded bg-gray-900 border border-gray-800 px-2 py-1 text-sm text-gray-200 placeholder-gray-600"
          />
          <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
            <span>{plural(total, "stream")}</span>
            <select
              value={only}
              onChange={(e) => setOnly(e.target.value as "all" | "waiting" | "needsYou")}
              aria-label="Which streams"
              className="cursor-pointer rounded bg-gray-900 border border-gray-800 px-1 py-0.5 text-xs text-gray-300"
            >
              <option value="all">all streams</option>
              <option value="needsYou">need you</option>
              <option value="waiting">waiting on anyone</option>
            </select>
          </div>
        </div>
        <ul className="overflow-y-auto flex-1">
          {streams.map((s) => (
            <li key={s.key}>
              <button
                onClick={() => setStreamKey(s.key)}
                className={`cursor-pointer w-full text-left px-3 py-2 text-sm border-b border-gray-900 ${streamKey === s.key ? "bg-gray-800 text-gray-100" : "text-gray-300 hover:bg-gray-900"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate">{streamLabel(s.label ?? s.key)}</span>
                  {s.needsYou > 0 && <span className="shrink-0 rounded bg-red-900/60 px-1.5 text-xs text-red-200">{s.needsYou} need you</span>}
                  {s.waiting > s.needsYou && <span className="shrink-0 rounded bg-amber-900/50 px-1.5 text-xs text-amber-200">{s.waiting - s.needsYou} waiting</span>}
                </div>
                <div className="text-xs text-gray-500">{plural(s.caseCount, "case")} · {plural(s.messages, "message")} · {when(s.last)}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="w-80 shrink-0 border-r border-gray-800 overflow-y-auto">
        {!streamKey && <p className="p-4 text-sm text-gray-500">Pick a stream.</p>}
        {cases.map((c) => (
          <button
            key={c.id}
            onClick={() => setCaseId(c.id)}
            className={`cursor-pointer w-full text-left px-3 py-2 text-sm border-b border-gray-900 ${caseId === c.id ? "bg-gray-800 text-gray-100" : "text-gray-300 hover:bg-gray-900"}`}
          >
            <div className="flex items-start gap-2">
              <span className="line-clamp-2 flex-1">{c.title || "(no text)"}</span>
              {c.status && <span className={`shrink-0 rounded px-1.5 text-xs ${STATUS_CLASSES[c.status] ?? "bg-gray-800 text-gray-400"}`}>{STATUS_LABELS[c.status] ?? c.status}</span>}
            </div>
            <div className="text-xs text-gray-500">{plural(c.size, "message")} · {when(c.first)} – {when(c.last)}{c.keys.length ? ` · ${c.keys.slice(0, 2).join(", ")}` : ""}</div>
          </button>
        ))}
      </section>

      <section className="flex-1 min-w-0 overflow-y-auto p-4">
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        {!graph && <p className="text-sm text-gray-500">Pick a case to see how its messages were grouped.</p>}
        {graph && (
          <>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-sm font-medium text-gray-200">{plural(graph.nodes.length, "message")}</h2>
              <span className="text-xs text-gray-500">{streamLabel(graph.case.streamLabel ?? graph.case.stream)}</span>
              {graph.case.keys.length > 0 && <span className="text-xs text-cyan-400">{graph.case.keys.join(", ")}</span>}
            </div>
            <Legend />
            <div className="mt-3">
              <CaseGraph data={graph} selected={selected} onSelect={setSelected} />
            </div>
            {node && <NodeDetail node={node} />}
          </>
        )}
      </section>
    </div>
  );
}
