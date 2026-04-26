import type { StreamData } from "../../lib/api";
import { openExternalUrl } from "../../lib/api";
import { buildSlackThreadUrl } from "../../messaging/slack/urls";
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
  pinned?: boolean;
  platformMeta?: Record<string, unknown>;
  onTogglePin?: () => void;
}

export default function StatusSnapshot({ data, pinned, platformMeta, onTogglePin }: StatusSnapshotProps) {
  const { workItem, unifiedStatus, statusSummary, agents, channels, threadCount, enrichment } = data;
  const status = workItem.currentAtcStatus ?? "noise";
  const style = STREAM_STATUS_STYLE[status] ?? STREAM_STATUS_STYLE.noise;

  return (
    <div className="px-5 py-4 border-b border-gray-800">
      {!workItem.id.startsWith("thread:") && (
        <div className="text-xs font-mono text-gray-500 mb-1">{workItem.id}</div>
      )}
      <div className="flex items-start justify-between gap-2 mb-2">
        <h2 className="text-lg font-semibold text-gray-100">
          {workItem.title || (workItem.id.startsWith("thread:") ? "Untitled conversation" : workItem.id)}
        </h2>
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            className={`cursor-pointer flex-shrink-0 p-1.5 rounded-md transition-all ${
              pinned
                ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 border border-transparent"
            }`}
            title={pinned ? "Unpin" : "Pin"}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2.5L13.5 6.5L10.5 9.5L11 13L8 10L5 13L5.5 9.5L2.5 6.5L6.5 2.5L8 4L9.5 2.5Z" />
            </svg>
          </button>
        )}
      </div>
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
          <span className="flex items-center gap-1">
            {channels.map((c) => {
              const workspaceUrl = platformMeta?.slackWorkspaceUrl as string | undefined;
              const threadUrl = workspaceUrl && data.latestThreadId
                ? buildSlackThreadUrl(workspaceUrl, c.id, data.latestThreadId)
                : null;
              return threadUrl ? (
                <button
                  key={c.id}
                  onClick={() => openExternalUrl(threadUrl)}
                  className="text-gray-500 hover:text-cyan-400 hover:underline cursor-pointer"
                >
                  #{c.name}
                </button>
              ) : (
                <span key={c.id}>#{c.name}</span>
              );
            })}
            {threadCount > 1 && <span>· {threadCount} threads</span>}
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
