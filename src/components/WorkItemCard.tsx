import { useState, type JSX } from "react";
import type { ActionableItem } from "../lib/api";
import { postAction } from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import ReplyBar from "./ReplyBar";

interface WorkItemCardProps {
  item: ActionableItem;
}

type ActionKind = "approve" | "redirect" | "close" | "snooze";

const ACTION_BUTTONS: { action: ActionKind; label: string; classes: string }[] = [
  { action: "approve", label: "Approve", classes: "bg-green-800/70 hover:bg-green-700 text-green-200" },
  { action: "redirect", label: "Redirect", classes: "bg-blue-800/70 hover:bg-blue-700 text-blue-200" },
  { action: "close", label: "Close", classes: "bg-gray-700/70 hover:bg-gray-600 text-gray-300" },
  { action: "snooze", label: "Snooze", classes: "bg-amber-800/70 hover:bg-amber-700 text-amber-200" },
];

export default function WorkItemCard({ item }: WorkItemCardProps): JSX.Element {
  const { workItem, latestEvent, agent, thread } = item;
  const [acting, setActing] = useState<ActionKind | null>(null);

  async function handleAction(action: ActionKind) {
    setActing(action);
    try {
      await postAction(
        workItem.id,
        action,
        undefined,
        action === "snooze" ? 3600 : undefined,
      );
    } catch {
      // Silently fail for now — the item will remain in the inbox
    } finally {
      setActing(null);
    }
  }

  const workItemLabel = workItem.id;
  const workItemUrl = workItem.url;

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      {/* Top row: ID + agent + time + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {workItemUrl ? (
              <a
                href={workItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm font-semibold text-blue-400 hover:underline"
              >
                {workItemLabel}
              </a>
            ) : (
              <span className="font-mono text-sm font-semibold text-gray-200">
                {workItemLabel}
              </span>
            )}
            {agent && (
              <span className="text-xs text-gray-400">
                {agent.name}
              </span>
            )}
            <span className="font-mono text-xs text-gray-500">
              {timeAgo(latestEvent.timestamp)}
            </span>
          </div>
          {workItem.title && (
            <p className="mt-0.5 text-xs text-gray-400 truncate">{workItem.title}</p>
          )}
        </div>
        <StatusBadge status={latestEvent.status} />
      </div>

      {/* Message text — truncated to 2 lines */}
      <p className="mt-2 text-sm text-gray-300 line-clamp-2 leading-relaxed">
        {latestEvent.rawText}
      </p>

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        {ACTION_BUTTONS.map(({ action, label, classes }) => (
          <button
            key={action}
            onClick={() => handleAction(action)}
            disabled={acting !== null}
            className={`rounded px-2.5 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed ${classes}`}
          >
            {acting === action ? "..." : label}
          </button>
        ))}
      </div>

      {/* Reply bar */}
      {thread && (
        <ReplyBar threadId={thread.id} channelId={thread.channelId} />
      )}
    </div>
  );
}
