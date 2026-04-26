import { useRef, useEffect } from "react";
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
  const prevCountRef = useRef(entries.length);

  // Auto-scroll to bottom on mount
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, []);

  // Auto-scroll to bottom when new entries arrive (appended at end = newest)
  useEffect(() => {
    if (entries.length > prevCountRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCountRef.current = entries.length;
  }, [entries.length]);

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
      {hasOlder && (
        <div className="flex justify-center mb-3">
          <button
            onClick={onLoadOlder}
            className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 bg-gray-800/60 hover:bg-gray-700/60 rounded-full px-3 py-1 transition-colors"
          >
            Load older messages
          </button>
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
