import { useState, useEffect, useCallback, useRef, type JSX } from "react";
import {
  fetchWorkItemContext,
  generateSummary,
  postReply,
  type WorkItemContext,
  type Mentionable,
} from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import MentionInput from "./MentionInput";
import MessageRenderer from "../platforms/MessageRenderer";
import { slackSerializeMention } from "../platforms/slack/mentions";

interface ContextPaneProps {
  workItemId: string;
  platformMeta?: Record<string, unknown>;
  userMap: Map<string, string>;
  mentionables: Mentionable[];
  onClose: () => void;
  onActioned?: () => void;
}

export default function ContextPane({
  workItemId,
  platformMeta,
  userMap,
  mentionables,
  onClose,
  onActioned,
}: ContextPaneProps): JSX.Element {
  const [context, setContext] = useState<WorkItemContext | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  // Fetch context on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const ctx = await fetchWorkItemContext(workItemId);
        if (!cancelled) {
          setContext(ctx);
          setSummary(ctx.summary);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load context");
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workItemId]);

  // Auto-generate summary if not cached
  useEffect(() => {
    if (context && !summary && !summarizing) {
      setSummarizing(true);
      generateSummary(workItemId)
        .then((res) => setSummary(res.summary))
        .catch(() => setSummary("Summary unavailable"))
        .finally(() => setSummarizing(false));
    }
  }, [context, summary, summarizing, workItemId]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Close on click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  async function handleQuickReply(text: string) {
    if (!context?.threads[0]) return;
    setActing(true);
    try {
      const thread = context.threads[0];
      await postReply(thread.id, thread.channelId, text);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setActing(false);
    }
  }

  async function handleReplySubmit(serializedText: string) {
    if (!context?.threads[0] || !serializedText) return;
    setActing(true);
    try {
      const thread = context.threads[0];
      await postReply(thread.id, thread.channelId, serializedText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setActing(false);
    }
  }

  // Loading state
  if (!context && !error) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6 overflow-y-auto animate-slide-in-right">
          <div className="flex items-center justify-between mb-6">
            <div className="h-5 w-32 bg-gray-800 rounded animate-pulse" />
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">&#x2715;</button>
          </div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-gray-900 rounded animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && !context) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
        <div ref={paneRef} className="w-full max-w-xl bg-gray-950 border-l border-gray-800 p-6">
          <div className="flex items-center justify-between mb-6">
            <span className="text-sm text-red-400">{error}</span>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer">&#x2715;</button>
          </div>
        </div>
      </div>
    );
  }

  if (!context) return <></>;

  const { workItem, events, enrichments, quickReplies, threads } = context;
  const jiraEnrichment = enrichments.find((e) => e.source === "jira");
  const thread = threads[0];
  const serializeMention = thread?.platform === "slack"
    ? slackSerializeMention
    : (id: string) => `@${id}`;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={handleBackdropClick}>
      <div
        ref={paneRef}
        className="w-full max-w-xl bg-gray-950 border-l border-gray-800 overflow-y-auto animate-slide-in-right"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-950 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold text-blue-400">
                {workItem.id}
              </span>
              <StatusBadge status={workItem.currentAtcStatus ?? "noise"} />
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer text-lg">&#x2715;</button>
          </div>
          {workItem.title && (
            <p className="mt-1 text-sm text-gray-300">{workItem.title}</p>
          )}
          {workItem.externalStatus && (
            <p className="mt-0.5 text-xs text-gray-500">
              Jira: {workItem.externalStatus}
              {workItem.assignee && ` \u00B7 ${workItem.assignee}`}
            </p>
          )}
        </div>

        <div className="px-6 py-4 space-y-6">
          {/* AI Summary */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Summary
            </h3>
            {summarizing ? (
              <div className="text-sm text-gray-500 animate-pulse">Generating summary...</div>
            ) : summary ? (
              <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {summary}
              </div>
            ) : (
              <div className="text-sm text-gray-500">No summary available</div>
            )}
          </section>

          {/* Jira Context */}
          {jiraEnrichment && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Jira
              </h3>
              <div className="rounded border border-gray-800 bg-gray-900 p-3 text-sm space-y-1">
                {(jiraEnrichment.data as Record<string, unknown>).description && (
                  <p className="text-gray-300">
                    {String((jiraEnrichment.data as Record<string, unknown>).description).slice(0, 500)}
                  </p>
                )}
                {(jiraEnrichment.data as Record<string, unknown>).status && (
                  <p className="text-xs text-gray-500">
                    Status: {String((jiraEnrichment.data as Record<string, unknown>).status)}
                  </p>
                )}
                {((jiraEnrichment.data as Record<string, unknown>).labels as string[] | undefined)?.length ? (
                  <p className="text-xs text-gray-500">
                    Labels: {((jiraEnrichment.data as Record<string, unknown>).labels as string[]).join(", ")}
                  </p>
                ) : null}
              </div>
            </section>
          )}

          {/* Conversation Thread */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Conversation ({events.length} messages)
            </h3>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {events.map((evt) => {
                const isHighlighted = evt.status !== "noise" && evt.status !== "in_progress";
                return (
                  <div
                    key={evt.id}
                    className={`rounded bg-gray-900 px-3 py-2 text-sm ${
                      isHighlighted ? "border-l-2 border-amber-500" : "border-l-2 border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                      <span>{timeAgo(evt.timestamp)}</span>
                      <StatusBadge status={evt.status} />
                    </div>
                    <div className="text-gray-300 whitespace-pre-wrap break-words">
                      <MessageRenderer
                        platform={thread?.platform ?? "unknown"}
                        text={evt.rawText}
                        userMap={userMap}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Quick Replies */}
          {quickReplies.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Quick Replies
              </h3>
              <div className="flex flex-wrap gap-2">
                {quickReplies.map((reply) => (
                  <button
                    key={reply}
                    onClick={() => handleQuickReply(reply)}
                    disabled={acting}
                    className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800 hover:border-gray-600 disabled:opacity-40"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Reply Input */}
          {thread && (
            <section>
              <MentionInput
                placeholder="Reply to thread..."
                disabled={acting}
                mentionables={mentionables}
                serializeMention={serializeMention}
                onSubmit={handleReplySubmit}
              />
            </section>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
