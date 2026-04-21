import type { StreamData } from "../../lib/api";
import { openExternalUrl } from "../../lib/api";
import CopyableId from "../CopyableId";

const STREAM_STATUS_STYLE: Record<string, { bg: string; text: string; border: string; dot?: string }> = {
  blocked_on_human: { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30", dot: "bg-red-400" },
  needs_decision:   { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30", dot: "bg-red-400" },
  in_progress:      { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" },
  completed:        { bg: "bg-green-500/15", text: "text-green-400", border: "border-green-500/30" },
  noise:            { bg: "bg-gray-700/50", text: "text-gray-300", border: "border-gray-700" },
};

const STATUS_LABELS: Record<string, string> = {
  blocked_on_human: "Blocked",
  needs_decision: "Needs Decision",
  in_progress: "In Progress",
  completed: "Completed",
  noise: "Noise",
};

interface StatusSnapshotProps {
  data: StreamData;
}

export default function StatusSnapshot({ data }: StatusSnapshotProps) {
  const { workItem, unifiedStatus, statusSummary, agents, channels, threadCount, enrichment } = data;
  const status = workItem.currentAtcStatus ?? "noise";
  const style = STREAM_STATUS_STYLE[status] ?? STREAM_STATUS_STYLE.noise;

  return (
    <div className="px-5 py-4 border-b border-gray-800">
      {!workItem.id.startsWith("thread:") && (
        <div className="text-xs font-mono text-gray-500 mb-1">{workItem.id}</div>
      )}
      <h2 className="text-lg font-semibold text-white mb-2">
        {workItem.title || (workItem.id.startsWith("thread:") ? "Untitled conversation" : workItem.id)}
      </h2>
      {import.meta.env.DEV && (
        <div className="mb-2"><CopyableId id={workItem.id} /></div>
      )}
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium mb-3 ${style.bg} ${style.text} border ${style.border}`}>
        {style.dot && <span className={`w-1.5 h-1.5 rounded-full ${style.dot} animate-pulse`} />}
        {unifiedStatus}
      </div>
      {data.nextAction && (
        <p className="text-xs text-gray-400 mt-1 pl-0.5">{data.nextAction}</p>
      )}
      {statusSummary && (
        <p className="text-sm text-gray-300 leading-relaxed mb-3">{statusSummary}</p>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        {agents.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
            {agents.map((a) => a.name).join(", ")}
          </span>
        )}
        {channels.length > 0 && (
          <span>
            {channels.map((c) => `#${c.name}`).join(", ")}
            {threadCount > 1 && ` · ${threadCount} threads`}
          </span>
        )}
        {enrichment && workItem.url && (
          <button
            onClick={() => openExternalUrl(workItem.url!)}
            className="text-cyan-500 hover:text-cyan-400 cursor-pointer"
          >
            {enrichment.source}: {workItem.externalStatus ?? "View"} ↗
          </button>
        )}
      </div>
    </div>
  );
}
