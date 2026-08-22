import { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { timeAgo } from "../../lib/time";
import { openExternalUrl } from "../../lib/api";
import { PlatformMessage } from "../../messaging/registry";
import { buildSlackThreadUrl } from "../../messaging/slack/urls";
import type { TimelineEntry as TimelineEntryType, Mentionable } from "../../lib/api";

interface TimelineProps {
  entries: TimelineEntryType[];
  hasOlder: boolean;
  platformMeta?: Record<string, unknown>;
  mentionables?: Mentionable[];
  onLoadOlder: () => void;
}

const STATUS_BORDER: Record<string, string> = {
  blocked_on_human: "border-red-500",
  needs_decision: "border-amber-500",
  completed: "border-green-500",
  noise: "border-gray-700",
  in_progress: "border-cyan-500/50",
};

function avatarColor(name: string): string {
  const colors = [
    "bg-cyan-700", "bg-purple-700", "bg-amber-700",
    "bg-rose-700", "bg-teal-700", "bg-indigo-700",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export default function Timeline({ entries, hasOlder, platformMeta, mentionables, onLoadOlder }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(entries.length);
  const savedScrollHeightRef = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Auto-scroll to bottom on initial mount
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, []);

  // Preserve scroll position when older messages are prepended;
  // auto-scroll to bottom when new messages are appended
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const prevCount = prevCountRef.current;
    const savedHeight = savedScrollHeightRef.current;

    if (entries.length > prevCount) {
      if (savedHeight !== null) {
        // Older messages prepended — keep user at same visual position
        container.scrollTop += container.scrollHeight - savedHeight;
        savedScrollHeightRef.current = null;
      } else if (prevCount > 0) {
        // New messages appended at end — scroll to bottom
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }

    setLoadingOlder(false);
    prevCountRef.current = entries.length;
  }, [entries]);

  // Trigger loading older messages — saves scroll height before load
  const triggerLoadOlder = useCallback(() => {
    if (loadingOlder || !hasOlder) return;
    const container = scrollRef.current;
    if (container) {
      savedScrollHeightRef.current = container.scrollHeight;
    }
    setLoadingOlder(true);
    onLoadOlder();
  }, [loadingOlder, hasOlder, onLoadOlder]);

  // Keep a ref to the latest trigger so the observer doesn't need to re-create
  const triggerRef = useRef(triggerLoadOlder);
  triggerRef.current = triggerLoadOlder;

  // Infinite scroll: observe sentinel at top of messages
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container || !hasOlder) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) triggerRef.current();
      },
      { root: container, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder]);

  // Safety: reset loading after timeout if fetch silently fails
  useEffect(() => {
    if (!loadingOlder) return;
    const timer = setTimeout(() => {
      savedScrollHeightRef.current = null;
      setLoadingOlder(false);
    }, 10000);
    return () => clearTimeout(timer);
  }, [loadingOlder]);

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        No messages yet
      </div>
    );
  }

  const workspaceUrl = platformMeta?.slackWorkspaceUrl as string | undefined;

  // Build user ID → display name map for resolving bare mentions like <@U123>
  const userMap = mentionables && mentionables.length > 0
    ? new Map(mentionables.map((m) => [m.id, m.name]))
    : undefined;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
      {/* Infinite scroll sentinel — triggers load when scrolled into view */}
      {hasOlder && <div ref={sentinelRef} className="h-px" />}
      {loadingOlder && (
        <div className="flex justify-center mb-3">
          <span className="text-xs text-gray-600 animate-pulse">Loading older messages…</span>
        </div>
      )}

      <div className="space-y-3">
        {entries.map((entry) => {
          const isOperator = entry.isOperator;
          const name = isOperator ? "You" : (entry.agentName ?? "Agent");
          const borderColor = isOperator
            ? "border-green-500"
            : (STATUS_BORDER[entry.status] ?? "border-gray-700");

          // Build thread URL for the channel link
          const threadUrl = workspaceUrl && entry.threadId && entry.platform === "slack" && entry.channelId
            ? buildSlackThreadUrl(workspaceUrl, entry.channelId, entry.threadId)
            : null;

          return (
            <div key={entry.id} className={`flex gap-2.5 border-l-2 pl-3 ${borderColor}`}>
              {/* Avatar */}
              {entry.agentAvatarUrl && !isOperator ? (
                <img
                  src={entry.agentAvatarUrl}
                  alt={name}
                  className="w-7 h-7 rounded-full flex-shrink-0 object-cover"
                />
              ) : (
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold text-white flex-shrink-0 ${
                    isOperator ? "bg-green-700" : avatarColor(name)
                  }`}
                >
                  {name.charAt(0).toUpperCase()}
                </div>
              )}

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={`text-xs font-medium ${isOperator ? "text-green-400" : "text-cyan-400"}`}>
                    {name}
                  </span>
                  <span className="text-[11px] text-gray-600">
                    {entry.channelName && (
                      threadUrl ? (
                        <button
                          onClick={() => openExternalUrl(threadUrl)}
                          className="hover:text-cyan-400 hover:underline cursor-pointer"
                        >
                          #{entry.channelName}
                        </button>
                      ) : (
                        <>#{entry.channelName}</>
                      )
                    )}
                    {entry.channelName && " · "}
                    {timeAgo(entry.timestamp)}
                  </span>
                </div>

                {/* Summary card */}
                <div className="mt-1 rounded bg-gray-800/50 px-3 py-2 text-[13px] text-gray-300 leading-relaxed">
                  {entry.summary}
                </div>

                {/* Raw text with platform-specific formatting */}
                {entry.rawText && entry.rawText !== entry.summary && (
                  <div className={`mt-1 text-xs leading-relaxed whitespace-pre-wrap ${
                    entry.relation === "mentioned" ? "text-gray-600" : "text-gray-500"
                  }`}>
                    {entry.relation === "mentioned" ? (
                      <details className="group">
                        <summary className="cursor-pointer text-gray-600 hover:text-gray-400 list-none">
                          <span className="text-[11px] italic">Mentioned in this thread</span>
                          <span className="ml-1 text-[10px] text-gray-700 group-open:hidden">Show full message</span>
                        </summary>
                        <div className="mt-1">
                          {entry.platform ? (
                            <PlatformMessage platform={entry.platform} text={entry.rawText} userMap={userMap} />
                          ) : (
                            entry.rawText
                          )}
                        </div>
                      </details>
                    ) : entry.platform ? (
                      <PlatformMessage platform={entry.platform} text={entry.rawText} userMap={userMap} />
                    ) : (
                      entry.rawText
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div ref={bottomRef} />
    </div>
  );
}
