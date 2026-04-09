import { useState, useRef, type JSX } from "react";
import type { ActionableItem, Mentionable } from "../lib/api";
import { postAction, postReply, openExternalUrl, createTicket } from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import Tooltip from "./Tooltip";
import MentionInput from "./MentionInput";
import MessageRenderer from "../messaging/MessageRenderer";
import ChannelLabel from "../messaging/ChannelLabel";
import { getSerializeMention } from "../messaging/registry";

interface WorkItemCardProps {
  item: ActionableItem;
  platformMeta?: Record<string, unknown>;
  userMap: Map<string, string>;
  mentionables: Mentionable[];
  onActioned?: () => void;
  onSelect?: (workItemId: string) => void;
}

type ActionKind = "done" | "unblock" | "dismiss" | "snooze";

const ACTION_BUTTONS: {
  action: ActionKind;
  label: string;
  classes: string;
  tooltip: string;
  primary?: boolean;
}[] = [
  {
    action: "unblock",
    label: "Unblock",
    classes: "bg-cyan-700/80 hover:bg-cyan-700 text-cyan-100",
    tooltip: "Unblock the agent \u2014 your reply lets them continue",
    primary: true,
  },
  {
    action: "done",
    label: "Done",
    classes: "bg-green-800/70 hover:bg-green-700 text-green-200",
    tooltip: "Mark as complete \u2014 work is finished or approved",
  },
  {
    action: "dismiss",
    label: "Dismiss",
    classes: "bg-gray-700/70 hover:bg-gray-600 text-gray-300",
    tooltip: "Dismiss \u2014 not relevant or a false positive",
  },
  {
    action: "snooze",
    label: "Snooze",
    classes: "bg-amber-800/70 hover:bg-amber-700 text-amber-200",
    tooltip: "Snooze for 1 hour \u2014 revisit later",
  },
];

/** Map new action names to server-side action values */
function toServerAction(action: ActionKind): string {
  switch (action) {
    case "done": return "approve";
    case "unblock": return "redirect";
    case "dismiss": return "close";
    case "snooze": return "snooze";
  }
}

/** First letter avatar fallback */
function AvatarFallback({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs font-semibold text-gray-300">
      {initial}
    </span>
  );
}

export default function WorkItemCard({ item, platformMeta, userMap, mentionables, onActioned, onSelect }: WorkItemCardProps): JSX.Element {
  const { workItem, latestEvent, agent, thread } = item;
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingTicket, setCreatingTicket] = useState(false);
  // Pending reply text set by MentionInput's onSubmit (Enter key = reply-only)
  // Action buttons read and clear this via a ref to avoid stale closures
  const pendingReply = useRef("");

  // Pick the right mention serializer based on platform
  const serializeMention = getSerializeMention(thread?.platform ?? "");

  async function handleAction(action: ActionKind) {
    setActing(action);
    setError(null);
    try {
      const message = pendingReply.current || undefined;
      await postAction(workItem.id, toServerAction(action), message, action === "snooze" ? 3600 : undefined);
      pendingReply.current = "";
      setDone(true);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  async function handleReplySubmit(serializedText: string) {
    if (!serializedText || !thread) return;
    setSending(true);
    setError(null);
    try {
      await postReply(thread.id, thread.channelId, serializedText);
      pendingReply.current = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setSending(false);
    }
  }

  const isInferred = workItem.source === "inferred" || workItem.id.startsWith("thread:");

  async function handleCreateTicket() {
    setCreatingTicket(true);
    setError(null);
    try {
      const result = await createTicket(workItem.id);
      if (result.ticketUrl) {
        openExternalUrl(result.ticketUrl);
      }
      setDone(true);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ticket");
    } finally {
      setCreatingTicket(false);
    }
  }

  const busy = acting !== null || sending || creatingTicket;

  return done ? (
    <div className="rounded border border-gray-800 bg-gray-900/50 p-4 opacity-40 transition-opacity duration-300">
      <p className="text-sm text-gray-500 text-center">Done</p>
    </div>
  ) : (
    <div
      className="rounded border border-gray-800 bg-gray-900 p-4 cursor-pointer hover:border-gray-700 transition-colors"
      onClick={() => onSelect?.(workItem.id)}
    >
      {/* Top row: ID + channel + time + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Work item ID or title for inferred items */}
            {isInferred ? (
              <span className="text-sm font-semibold animate-shimmer">
                {workItem.title || "Untitled conversation"}
              </span>
            ) : workItem.url ? (
              <button
                type="button"
                onClick={() => openExternalUrl(workItem.url!)}
                className="font-mono text-sm font-semibold text-cyan-400 hover:underline cursor-pointer"
              >
                {workItem.id}
              </button>
            ) : (
              <span className="font-mono text-sm font-semibold text-gray-200">
                {workItem.id}
              </span>
            )}

            {/* Channel label — platform-aware */}
            {thread?.channelName && (
              <ChannelLabel thread={thread} platformMeta={platformMeta} />
            )}

            {/* Timestamp — no font-mono to avoid wide spacing */}
            <span className="text-xs text-gray-500">
              {timeAgo(latestEvent.timestamp)}
            </span>
          </div>
          {workItem.title && !isInferred && (
            <p className="mt-0.5 text-xs text-gray-400 truncate">{workItem.title}</p>
          )}
        </div>
        <StatusBadge status={workItem.currentAtcStatus ?? latestEvent.status} />
      </div>

      {/* Message bubble — darker background for visual separation */}
      <div className="mt-3 rounded-lg bg-gray-950 border border-gray-800/60 px-3.5 py-3">
        <div className="flex gap-3">
          {agent && (
            <div className="shrink-0 pt-0.5">
              {agent.avatarUrl ? (
                <img src={agent.avatarUrl} alt={agent.name} className="h-7 w-7 rounded-full" />
              ) : (
                <AvatarFallback name={agent.name} />
              )}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {agent && (
              <span className="text-xs font-medium text-gray-400">{agent.name}</span>
            )}
            <div className="mt-0.5 text-sm text-gray-300 leading-relaxed whitespace-pre-wrap break-words">
              <MessageRenderer
                platform={thread?.platform ?? "unknown"}
                text={latestEvent.rawText}
                userMap={userMap}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Reply input + action buttons */}
      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
        {thread && (
          <MentionInput
            placeholder="Reply (type @ to mention). Enter sends, or click an action below."
            disabled={busy}
            mentionables={mentionables}
            serializeMention={serializeMention}
            onSubmit={handleReplySubmit}
          />
        )}

        <div className="flex items-center gap-2 flex-wrap">

          {/* Action buttons */}
          {ACTION_BUTTONS.map(({ action, label, classes, tooltip, primary }) => (
            <Tooltip key={action} text={tooltip}>
              <button
                onClick={() => handleAction(action)}
                disabled={busy}
                className={`cursor-pointer rounded px-2.5 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed ${classes} ${primary ? "px-3.5" : ""}`}
              >
                {acting === action ? "..." : label}
              </button>
            </Tooltip>
          ))}

          {/* Create Ticket — only for inferred/unticketed work items */}
          {isInferred && (
            <Tooltip text="Create a ticket from this conversation">
              <button
                onClick={handleCreateTicket}
                disabled={busy}
                className="cursor-pointer rounded px-2.5 py-1 text-xs font-medium bg-purple-800/70 hover:bg-purple-700 text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creatingTicket ? "..." : "Create Ticket"}
              </button>
            </Tooltip>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
