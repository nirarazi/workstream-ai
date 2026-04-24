import { useState } from "react";
import { timeAgo } from "../../lib/time";
import { PlatformMessage } from "../../messaging/registry";
import type { TimelineEntry as TimelineEntryType } from "../../lib/api";

const ENTRY_ICONS: Record<string, string> = {
  block: "⏳",
  decision: "✅",
  progress: "🔨",
  assignment: "📋",
  escalation: "🚩",
};

interface TimelineEntryProps {
  entry: TimelineEntryType;
}

export default function TimelineEntryComponent({ entry }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div
        onClick={() => entry.rawText && setExpanded(!expanded)}
        className={`flex gap-2.5 py-1.5 rounded cursor-pointer hover:bg-white/[0.03] ${
          entry.entryType === "decision"
            ? "bg-cyan-500/[0.06] border-l-2 border-cyan-500 pl-2 -ml-2"
            : ""
        }`}
      >
        <span className="w-6 h-6 flex items-center justify-center text-sm flex-shrink-0">
          {ENTRY_ICONS[entry.entryType] ?? "·"}
        </span>
        <div className="flex-1 min-w-0">
          {entry.entryType === "decision" && (
            <div className="text-[10px] uppercase tracking-wider text-cyan-500 font-semibold mb-0.5">
              Your Decision
            </div>
          )}
          <div className="text-[13px] text-gray-300 leading-snug">{entry.summary}</div>
          <div className="text-[11px] text-gray-600 mt-0.5">{entry.channelName}</div>
        </div>
        <span className="text-[11px] text-gray-600 flex-shrink-0 pt-0.5">
          {timeAgo(entry.timestamp)}
        </span>
      </div>
      {expanded && entry.rawText && (
        <div className="ml-8 mt-1 mb-2 border-l-2 border-gray-800 pl-3">
          <div className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
            <span className={`font-medium ${entry.isOperator ? "text-purple-400" : "text-cyan-400"}`}>
              {entry.isOperator ? "You" : entry.agentName ?? "Agent"}
            </span>
            <span className="text-gray-600 ml-2 text-[11px]">
              {entry.channelName} · {timeAgo(entry.timestamp)}
            </span>
            <div className="mt-1 text-gray-400">
              <PlatformMessage platform={entry.platform || "slack"} text={entry.rawText} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
