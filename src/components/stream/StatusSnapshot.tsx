import type { StreamData } from "../../lib/api";

interface StatusSnapshotProps {
  data: StreamData;
}

export default function StatusSnapshot({ data }: StatusSnapshotProps) {
  const { workItem, unifiedStatus, statusSummary, agents, channels, threadCount, enrichment } = data;
  const isBlocked = workItem.currentAtcStatus === "blocked_on_human" || workItem.currentAtcStatus === "needs_decision";

  return (
    <div className="px-5 py-4 border-b border-gray-800">
      {!workItem.id.startsWith("thread:") && (
        <div className="text-xs font-mono text-gray-500 mb-1">{workItem.id}</div>
      )}
      <h2 className="text-lg font-semibold text-white mb-3">
        {workItem.title || workItem.id}
      </h2>
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium mb-3 ${
        isBlocked
          ? "bg-red-500/15 text-red-400 border border-red-500/30"
          : "bg-gray-700/50 text-gray-300 border border-gray-700"
      }`}>
        {isBlocked && <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />}
        {unifiedStatus}
      </div>
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
          <a
            href={workItem.url}
            onClick={(e) => { e.preventDefault(); window.open(workItem.url!); }}
            className="text-cyan-500 hover:text-cyan-400"
          >
            {enrichment.source}: {workItem.externalStatus ?? "View"} ↗
          </a>
        )}
      </div>
    </div>
  );
}
