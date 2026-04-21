import { useState, useEffect } from "react";
import { type ActionableItem } from "../../lib/api";
import StatusBadge, { type ActionState } from "../StatusBadge";

const BORDER_COLORS: Record<string, string> = {
  blocked_on_human: "border-l-red-500",
  needs_decision: "border-l-amber-500",
  in_progress: "border-l-blue-500",
  completed: "border-l-green-500",
  noise: "border-l-gray-600",
};

interface StreamListItemProps {
  item: ActionableItem;
  selected: boolean;
  actionState: ActionState;
  resolving?: boolean;
  onSelect: () => void;
}

export default function StreamListItem({ item, selected, actionState, resolving, onSelect }: StreamListItemProps) {
  const { workItem, latestEvent, agent } = item;
  const status = workItem.currentAtcStatus ?? "noise";
  const borderColor = BORDER_COLORS[status] ?? "border-l-gray-600";
  const isSnoozed = Boolean(workItem.snoozedUntil);
  const isPinned = workItem.pinned;
  // Track whether this item has just mounted so we can apply the enter animation once
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // Trigger enter animation on mount
    const t = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const timeAgo = latestEvent?.timestamp
    ? formatRelativeTime(new Date(latestEvent.timestamp))
    : "";

  return (
    <div
      onClick={onSelect}
      className={`
        px-4 py-3 border-b border-gray-800/50 border-l-[3px] cursor-pointer
        transition-all duration-200
        ${borderColor}
        ${selected ? "bg-gray-900/80" : "hover:bg-gray-900/40"}
        ${isSnoozed ? "opacity-50" : ""}
        ${resolving ? "animate-list-exit pointer-events-none" : !entered ? "animate-list-enter" : ""}
      `}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 min-w-0">
          {isPinned && <span className="text-[10px] text-gray-600">📌</span>}
          <span className="text-xs font-semibold text-gray-200 truncate">{workItem.id}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge
            status={status}
            actionState={actionState}
            snoozedUntil={workItem.snoozedUntil}
          />
          <span className="text-[10px] text-gray-600">{timeAgo}</span>
        </div>
      </div>
      <div className="text-xs text-gray-400 mt-1 truncate">{workItem.title}</div>
      <div className="text-[10px] text-gray-600 mt-0.5">
        {agent?.name ?? "Unknown"}
        {latestEvent?.reason && (
          <span className="ml-1 text-gray-700">· {truncate(latestEvent.reason, 60)}</span>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
