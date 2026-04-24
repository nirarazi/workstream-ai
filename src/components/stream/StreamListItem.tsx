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
  mergingAway?: boolean;
  onSelect: () => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  onDrop?: (targetId: string) => void;
  onDragEnter?: (id: string) => void;
  dragOverId?: string | null;
}

export default function StreamListItem({ item, selected, actionState, resolving, mergingAway, onSelect, onDragStart, onDragEnd, onDrop, onDragEnter, dragOverId }: StreamListItemProps) {
  const { workItem, latestEvent, agent } = item;
  const isThreadItem = workItem.id.startsWith("thread:");
  const status = workItem.currentAtcStatus ?? "noise";
  const borderColor = BORDER_COLORS[status] ?? "border-l-gray-600";
  const isSnoozed = Boolean(workItem.snoozedUntil);
  const isPinned = workItem.pinned;
  const isDragOver = dragOverId === workItem.id;

  // For thread-based items, derive a display title: use the work item title if
  // present, otherwise build a contextual label from the channel name.
  const threadDisplayTitle = isThreadItem
    ? workItem.title || (item.thread?.channelName ? `Thread in #${item.thread.channelName}` : "Untitled conversation")
    : null;
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
      draggable
      onClick={onSelect}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", workItem.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(workItem.id);
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragEnter?.(workItem.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.(workItem.id);
      }}
      className={`
        px-4 py-3 border-b border-gray-800/50 border-l-[3px] cursor-pointer
        transition-all duration-200 relative
        ${borderColor}
        ${selected ? "bg-gray-900/80" : "hover:bg-gray-900/40"}
        ${isSnoozed ? "opacity-50" : ""}
        ${isDragOver ? "ring-1 ring-purple-500 animate-merge-glow" : ""}
        ${mergingAway ? "animate-merge-absorb pointer-events-none" : resolving ? "animate-list-exit pointer-events-none" : !entered ? "animate-list-enter" : ""}
      `}
    >
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-purple-900/20 rounded text-purple-400 text-xs font-medium z-10">
          ⤵ Drop to merge
        </div>
      )}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 min-w-0">
          {isPinned && <span className="text-[10px] text-gray-600">📌</span>}
          {isThreadItem ? (
            <span className="text-xs font-semibold text-gray-200 truncate animate-shimmer">{threadDisplayTitle}</span>
          ) : (
            <span className="text-xs font-semibold text-gray-200 truncate">{workItem.id}</span>
          )}
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
      {!isThreadItem && (
        <div className="text-xs mt-1 truncate text-gray-400">
          {workItem.title || "Untitled conversation"}
        </div>
      )}
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
