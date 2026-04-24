import { useState, useEffect } from "react";
import type { StreamData } from "../../lib/api";
import { postAction, createTicket, openExternalUrl } from "../../lib/api";
import SnoozeDropdown from "./SnoozeDropdown";
import MergeDropdown from "./MergeDropdown";

type ActionKind = "unblock" | "done" | "dismiss" | "snooze" | "noise";

const ACTION_BUTTONS: {
  action: ActionKind;
  label: string;
  classes: string;
  primary?: boolean;
}[] = [
  {
    action: "unblock",
    label: "Unblock",
    classes: "bg-cyan-700/80 hover:bg-cyan-700 text-cyan-100",
    primary: true,
  },
  {
    action: "done",
    label: "Done",
    classes: "bg-green-800/70 hover:bg-green-700 text-green-200",
  },
  {
    action: "dismiss",
    label: "Dismiss",
    classes: "bg-gray-700/70 hover:bg-gray-600 text-gray-300",
  },
  {
    action: "noise",
    label: "Noise",
    classes: "bg-gray-800/70 hover:bg-gray-700 text-gray-400",
  },
];

function toServerAction(action: ActionKind): string {
  switch (action) {
    case "done": return "approve";
    case "unblock": return "redirect";
    case "dismiss": return "dismiss";
    case "snooze": return "snooze";
    case "noise": return "noise";
  }
}

interface SuggestedActionsProps {
  data: StreamData;
  onActioned?: () => void;
  getReplyText?: () => string | undefined;
  onActionComplete?: (actionKind: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onMerge?: (targetId: string) => void;
  recentlyViewed?: Array<{ id: string; title: string; channelName?: string; timeAgo?: string }>;
  workItemId?: string;
}

export default function SuggestedActions({ data, onActioned, getReplyText, onActionComplete, pinned, onTogglePin, onMerge, recentlyViewed, workItemId }: SuggestedActionsProps) {
  const { workItem } = data;
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);

  const isInferred = workItem.source === "inferred" || workItem.id.startsWith("thread:");
  const busy = acting !== null || creatingTicket;

  async function handleAction(action: ActionKind, snoozeDuration?: number) {
    setActing(action);
    setError(null);
    try {
      const message = getReplyText?.() || undefined;
      await postAction(workItem.id, toServerAction(action), message, action === "snooze" ? (snoozeDuration ?? 60) : undefined);
      onActioned?.();
      onActionComplete?.(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  useEffect(() => {
    const handler = () => setShowMerge(true);
    window.addEventListener("workstream:open-merge-dropdown", handler);
    return () => window.removeEventListener("workstream:open-merge-dropdown", handler);
  }, []);

  async function handleCreateTicket() {
    setCreatingTicket(true);
    setError(null);
    try {
      const result = await createTicket(workItem.id);
      if (result.ticketUrl) {
        openExternalUrl(result.ticketUrl);
      }
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ticket");
    } finally {
      setCreatingTicket(false);
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Actions</div>
      <div className="flex flex-wrap gap-2">
        {ACTION_BUTTONS.map(({ action, label, classes, primary }) => (
          <button
            key={action}
            onClick={() => handleAction(action)}
            disabled={busy}
            className={`cursor-pointer rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed ${classes} ${primary ? "px-3.5" : ""}`}
          >
            {acting === action ? "..." : label}
          </button>
        ))}
        <SnoozeDropdown
          disabled={busy}
          onSnooze={(seconds) => handleAction("snooze", seconds)}
        />
        {onTogglePin && (
          <button
            onClick={onTogglePin}
            disabled={busy}
            className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-gray-700/50 hover:bg-gray-600 text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        )}
        {isInferred && (
          <button
            onClick={handleCreateTicket}
            disabled={busy}
            className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-purple-800/70 hover:bg-purple-700 text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creatingTicket ? "..." : "Create Ticket"}
          </button>
        )}
        {onMerge && (
          <div className="relative">
            <button
              onClick={() => setShowMerge(!showMerge)}
              className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-purple-800/70 hover:bg-purple-700 text-purple-200 transition-colors"
            >
              ⤵ Merge into…
            </button>
            {showMerge && (
              <MergeDropdown
                recentlyViewed={recentlyViewed ?? []}
                currentItemId={workItemId ?? ""}
                onSelect={(targetId) => {
                  onMerge(targetId);
                  setShowMerge(false);
                }}
                onClose={() => setShowMerge(false)}
              />
            )}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
