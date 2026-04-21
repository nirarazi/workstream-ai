import { useState } from "react";
import type { TimelineEntry as TimelineEntryType } from "../../lib/api";
import TimelineEntryComponent from "./TimelineEntry";

interface TimelineProps {
  entries: TimelineEntryType[];
}

export default function Timeline({ entries }: TimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const decisionCount = entries.filter((e) => e.entryType === "decision").length;
  const oldestDate = entries.length > 0 ? entries[entries.length - 1].timestamp : "";
  const daySpan = oldestDate
    ? Math.ceil((Date.now() - new Date(oldestDate).getTime()) / 86400000)
    : 0;

  const groups = new Map<string, TimelineEntryType[]>();
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label: string;
    if (date.toDateString() === today.toDateString()) {
      label = "Today";
    } else if (date.toDateString() === yesterday.toDateString()) {
      label = "Yesterday";
    } else {
      label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  return (
    <div className="border-b border-gray-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] cursor-pointer"
      >
        <span className="text-[11px] uppercase tracking-widest text-gray-600">Timeline</span>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {daySpan > 0 && <span>📅 {daySpan}d</span>}
          {decisionCount > 0 && <span>✅ {decisionCount} decisions</span>}
          <span>💬 {entries.length} events</span>
          <span className={`text-[11px] text-gray-600 transition-transform ${expanded ? "rotate-180" : ""}`}>▼</span>
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4">
          {Array.from(groups.entries()).map(([label, groupEntries]) => (
            <div key={label} className="mb-3">
              <div className="text-[11px] uppercase tracking-wider text-gray-600 mb-2 pb-1 border-b border-gray-800/50">
                {label}
              </div>
              {groupEntries.map((entry) => (
                <TimelineEntryComponent key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
