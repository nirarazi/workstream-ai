import { useState, useEffect, useCallback, useRef, type JSX } from "react";
import {
  fetchWorkItemContext,
  generateSummary,
  postReply,
  postAction,
  postForward,
  linkThread as apiLinkThread,
  unlinkThread as apiUnlinkThread,
  fetchUnlinkedThreads,
  linkThreadByUrl,
  type WorkItemContext,
  type Mentionable,
  type Thread,
} from "../lib/api";
import CreateTicketButton from "./CreateTicketButton";
import Tooltip from "./Tooltip";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import MentionInput, { type MentionInputHandle } from "./MentionInput";
import MessageRenderer from "../messaging/MessageRenderer";
import { getSerializeMention } from "../messaging/registry";

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
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [actionPanel, setActionPanel] = useState<"link" | "forward" | "new-thread" | null>(null);
  const [unlinkedThreads, setUnlinkedThreads] = useState<Thread[]>([]);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linking, setLinking] = useState(false);
  const [forwardTarget, setForwardTarget] = useState("");
  const [forwardTargetType, setForwardTargetType] = useState<"user" | "channel">("channel");
  const [forwardQuoteMode, setForwardQuoteMode] = useState<"latest" | "full">("latest");
  const [forwardIncludeSummary, setForwardIncludeSummary] = useState(false);
  const [forwardNote, setForwardNote] = useState("");
  const [forwarding, setForwarding] = useState(false);

  const [newThreadTarget, setNewThreadTarget] = useState("");
  const [newThreadTargetType, setNewThreadTargetType] = useState<"user" | "channel">("channel");
  const [newThreadMessage, setNewThreadMessage] = useState("");
  const [sendingNewThread, setSendingNewThread] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<MentionInputHandle>(null);

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

  const [prefill, setPrefill] = useState<{ text: string; key: number } | undefined>(undefined);

  async function handleQuickReply(text: string, shiftHeld: boolean) {
    if (!context?.threads[0]) return;
    if (!shiftHeld) {
      // Populate the input for review
      setPrefill({ text, key: Date.now() });
      return;
    }
    // Shift+click: send immediately
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
      await postReply(thread.id, thread.channelId, serializedText, { workItemId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setActing(false);
    }
  }

  async function handlePaneAction(action: string, serverAction: string) {
    setActing(true);
    setError(null);
    try {
      const message = inputRef.current?.serialize() || undefined;
      await postAction(workItemId, serverAction, message, action === "snooze" ? 3600 : undefined);
      inputRef.current?.clear();
      onActioned?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  // Fetch unlinked threads when link panel opens
  useEffect(() => {
    if (actionPanel !== "link") return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchUnlinkedThreads(20, linkSearch || undefined);
        if (!cancelled) setUnlinkedThreads(res.threads);
      } catch {
        if (!cancelled) setUnlinkedThreads([]);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [actionPanel, linkSearch]);

  async function handleLinkThread(threadId: string) {
    setLinking(true);
    try {
      await apiLinkThread(workItemId, threadId);
      setActionPanel(null);
      // Refresh context
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setLinking(false);
    }
  }

  async function handleLinkUrl() {
    if (!linkUrl.trim()) return;
    setLinking(true);
    try {
      await linkThreadByUrl(workItemId, linkUrl.trim());
      setLinkUrl("");
      setActionPanel(null);
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlinkThread(threadId: string) {
    try {
      await apiUnlinkThread(workItemId, threadId);
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
      setSummary(ctx.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlink failed");
    }
  }

  async function handleForward() {
    if (!selectedThreadId || !forwardTarget.trim()) return;
    const selectedThread = context?.threads.find((t) => t.id === selectedThreadId);
    if (!selectedThread) return;

    setForwarding(true);
    try {
      await postForward({
        sourceThreadId: selectedThreadId,
        sourceChannelId: selectedThread.channelId,
        targetId: forwardTarget.trim(),
        targetType: forwardTargetType,
        quoteMode: forwardQuoteMode,
        includeSummary: forwardIncludeSummary,
        note: forwardNote || undefined,
      });
      setActionPanel(null);
      setForwardTarget("");
      setForwardNote("");
      // Refresh context to show newly linked thread
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forward failed");
    } finally {
      setForwarding(false);
    }
  }

  async function handleNewThread() {
    if (!newThreadTarget.trim() || !newThreadMessage.trim()) return;
    setSendingNewThread(true);
    try {
      await postReply(
        undefined,
        newThreadTargetType === "channel" ? newThreadTarget.trim() : undefined,
        newThreadMessage.trim(),
        {
          targetUserId: newThreadTargetType === "user" ? newThreadTarget.trim() : undefined,
          workItemId,
        },
      );
      setActionPanel(null);
      setNewThreadTarget("");
      setNewThreadMessage("");
      const ctx = await fetchWorkItemContext(workItemId);
      setContext(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingNewThread(false);
    }
  }

  // Loading state
  if (!context && !error) {
    return (
      <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
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
      <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
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
  const taskEnrichment = enrichments[0]; // Show first available enrichment from any task adapter
  const thread = threads[0];
  const serializeMention = getSerializeMention(thread?.platform ?? "");

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
      <div
        ref={paneRef}
        className="w-full max-w-xl bg-gray-950 border-l border-gray-800 overflow-y-auto animate-slide-in-right"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-950 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {!workItem.id.startsWith("thread:") && (
                <span className="font-mono text-sm font-semibold text-cyan-400">
                  {workItem.id}
                </span>
              )}
              <StatusBadge status={workItem.currentAtcStatus ?? "noise"} />
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer text-lg">&#x2715;</button>
          </div>
          <p className="mt-1 text-sm text-gray-300">{workItem.title || "Untitled conversation"}</p>
          {workItem.externalStatus && (
            <p className="mt-0.5 text-xs text-gray-500">
              {workItem.externalStatus}
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

          {/* Task Adapter Enrichment */}
          {taskEnrichment && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                {taskEnrichment.source.charAt(0).toUpperCase() + taskEnrichment.source.slice(1)}
              </h3>
              <div className="rounded border border-gray-800 bg-gray-900 p-3 text-sm space-y-1">
                {(taskEnrichment.data as Record<string, unknown>).description && (
                  <p className="text-gray-300">
                    {String((taskEnrichment.data as Record<string, unknown>).description).slice(0, 500)}
                  </p>
                )}
                {(taskEnrichment.data as Record<string, unknown>).status && (
                  <p className="text-xs text-gray-500">
                    Status: {String((taskEnrichment.data as Record<string, unknown>).status)}
                  </p>
                )}
                {((taskEnrichment.data as Record<string, unknown>).labels as string[] | undefined)?.length ? (
                  <p className="text-xs text-gray-500">
                    Labels: {((taskEnrichment.data as Record<string, unknown>).labels as string[]).join(", ")}
                  </p>
                ) : null}
              </div>
            </section>
          )}

          {/* Conversations */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Conversations ({threads.length})
            </h3>
            <div className="space-y-1.5">
              {threads.map((t) => (
                <div
                  key={t.id}
                  onClick={() => setSelectedThreadId(selectedThreadId === t.id ? null : t.id)}
                  className={`rounded border px-3 py-2 text-sm cursor-pointer transition-colors ${
                    selectedThreadId === t.id
                      ? "border-cyan-600 bg-cyan-900/20"
                      : "border-gray-800 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-gray-300">{t.channelName || t.channelId}</span>
                      {t.manuallyLinked && (
                        <span className="ml-2 text-[10px] text-cyan-400">manually linked</span>
                      )}
                    </div>
                    {t.manuallyLinked && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnlinkThread(t.id); }}
                        className="text-gray-600 hover:text-gray-400 text-xs cursor-pointer"
                        title="Unlink thread"
                      >
                        &#x2715;
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {t.messageCount} messages · {timeAgo(t.lastActivity)}
                  </div>
                </div>
              ))}
            </div>

            {/* Action bar */}
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
              <button
                onClick={() => setActionPanel(actionPanel === "link" ? null : "link")}
                className={`flex-1 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors ${
                  actionPanel === "link"
                    ? "border border-cyan-600 text-cyan-400 bg-cyan-900/20"
                    : "border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                + Link thread
              </button>
              <button
                disabled={!selectedThreadId}
                onClick={() => setActionPanel(actionPanel === "forward" ? null : "forward")}
                className={`flex-1 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  actionPanel === "forward"
                    ? "border border-cyan-600 text-cyan-400 bg-cyan-900/20"
                    : "border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                Forward
              </button>
              <button
                onClick={() => setActionPanel(actionPanel === "new-thread" ? null : "new-thread")}
                className="flex-1 py-1.5 rounded text-xs font-medium cursor-pointer border border-gray-700 text-gray-400 hover:text-gray-300 hover:border-gray-600 transition-colors"
              >
                New thread
              </button>
            </div>

            {/* Link thread panel */}
            {actionPanel === "link" && (
              <div className="mt-3 border border-cyan-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="p-3 border-b border-gray-800">
                  <input
                    type="text"
                    placeholder="Search by channel name..."
                    value={linkSearch}
                    onChange={(e) => setLinkSearch(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {unlinkedThreads.length === 0 ? (
                    <div className="p-3 text-xs text-gray-500 text-center">No unlinked threads found</div>
                  ) : (
                    unlinkedThreads.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => handleLinkThread(t.id)}
                        disabled={linking}
                        className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors cursor-pointer disabled:opacity-50 border-b border-gray-800 last:border-b-0"
                      >
                        <div className="text-sm text-gray-300">{t.channelName || t.channelId}</div>
                        <div className="text-xs text-gray-500">{t.messageCount} messages · {timeAgo(t.lastActivity)}</div>
                      </button>
                    ))
                  )}
                </div>
                <div className="p-3 border-t border-gray-800">
                  <div className="text-xs text-gray-500 mb-1.5">Or paste a thread URL</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Paste thread URL..."
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleLinkUrl()}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600"
                    />
                    <button
                      onClick={handleLinkUrl}
                      disabled={!linkUrl.trim() || linking}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Link
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Forward panel */}
            {actionPanel === "forward" && selectedThreadId && (
              <div className="mt-3 border border-cyan-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                  <span className="text-xs font-semibold text-cyan-400">
                    Forward from {threads.find((t) => t.id === selectedThreadId)?.channelName ?? "thread"}
                  </span>
                  <button onClick={() => setActionPanel(null)} className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm">&#x2715;</button>
                </div>
                <div className="p-3 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">To</label>
                    <div className="flex gap-2">
                      <select
                        value={forwardTargetType}
                        onChange={(e) => setForwardTargetType(e.target.value as "user" | "channel")}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                      >
                        <option value="channel">Channel</option>
                        <option value="user">User</option>
                      </select>
                      <input
                        type="text"
                        placeholder={forwardTargetType === "channel" ? "Channel ID (e.g. C001)" : "User ID (e.g. U001)"}
                        value={forwardTarget}
                        onChange={(e) => setForwardTarget(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Quote</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setForwardQuoteMode("latest")}
                        className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                          forwardQuoteMode === "latest" ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-400 border border-gray-700"
                        }`}
                      >
                        Latest message
                      </button>
                      <button
                        onClick={() => setForwardQuoteMode("full")}
                        className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                          forwardQuoteMode === "full" ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-400 border border-gray-700"
                        }`}
                      >
                        Full thread
                      </button>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={forwardIncludeSummary}
                      onChange={(e) => setForwardIncludeSummary(e.target.checked)}
                      disabled={!summary}
                      className="rounded"
                    />
                    Attach summary {!summary && <span className="text-gray-600">(no summary available)</span>}
                  </label>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Your note</label>
                    <input
                      type="text"
                      placeholder="Add context for the recipient..."
                      value={forwardNote}
                      onChange={(e) => setForwardNote(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setActionPanel(null)}
                      className="px-3 py-1.5 rounded text-xs border border-gray-700 text-gray-400 hover:text-gray-300 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleForward}
                      disabled={!forwardTarget.trim() || forwarding}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {forwarding ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* New thread panel */}
            {actionPanel === "new-thread" && (
              <div className="mt-3 border border-cyan-600 rounded-md bg-gray-900 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                  <span className="text-xs font-semibold text-cyan-400">New thread</span>
                  <button onClick={() => setActionPanel(null)} className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm">&#x2715;</button>
                </div>
                <div className="p-3 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">To</label>
                    <div className="flex gap-2">
                      <select
                        value={newThreadTargetType}
                        onChange={(e) => setNewThreadTargetType(e.target.value as "user" | "channel")}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                      >
                        <option value="channel">Channel</option>
                        <option value="user">User</option>
                      </select>
                      <input
                        type="text"
                        placeholder={newThreadTargetType === "channel" ? "Channel ID (e.g. C001)" : "User ID (e.g. U001)"}
                        value={newThreadTarget}
                        onChange={(e) => setNewThreadTarget(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Message</label>
                    <textarea
                      placeholder="Write your message..."
                      value={newThreadMessage}
                      onChange={(e) => setNewThreadMessage(e.target.value)}
                      rows={3}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-600 resize-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setActionPanel(null)}
                      className="px-3 py-1.5 rounded text-xs border border-gray-700 text-gray-400 hover:text-gray-300 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleNewThread}
                      disabled={!newThreadTarget.trim() || !newThreadMessage.trim() || sendingNewThread}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {sendingNewThread ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Event history */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
              Event History ({events.length})
            </h3>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {[...events].reverse().map((evt) => {
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
              <div className="flex items-baseline gap-2 mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                  Quick Replies
                </h3>
                <span className="text-[10px] text-gray-600">Click to draft. Shift+click to send.</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {quickReplies.map((reply) => (
                  <button
                    key={reply}
                    onClick={(e) => handleQuickReply(reply, e.shiftKey)}
                    disabled={acting}
                    className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800 hover:border-gray-600 disabled:opacity-40"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Reply Input + Action Buttons */}
          {thread && (
            <section className="space-y-2">
              <MentionInput
                ref={inputRef}
                placeholder="Reply to thread..."
                disabled={acting}
                mentionables={mentionables}
                serializeMention={serializeMention}
                onSubmit={handleReplySubmit}
                prefill={prefill}
              />
              <div className="flex items-center gap-2 flex-wrap">
                <Tooltip text="Unblock the agent — your reply lets them continue">
                  <button onClick={() => handlePaneAction("unblock", "redirect")} disabled={acting} className="cursor-pointer rounded px-3.5 py-1 text-xs font-medium bg-cyan-700/80 hover:bg-cyan-700 text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed">Unblock</button>
                </Tooltip>
                <Tooltip text="Mark as complete — work is finished or approved">
                  <button onClick={() => handlePaneAction("done", "approve")} disabled={acting} className="cursor-pointer rounded px-2.5 py-1 text-xs font-medium bg-green-800/70 hover:bg-green-700 text-green-200 disabled:opacity-40 disabled:cursor-not-allowed">Done</button>
                </Tooltip>
                <Tooltip text="Dismiss — not relevant or a false positive">
                  <button onClick={() => handlePaneAction("dismiss", "close")} disabled={acting} className="cursor-pointer rounded px-2.5 py-1 text-xs font-medium bg-gray-700/70 hover:bg-gray-600 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed">Dismiss</button>
                </Tooltip>
                <Tooltip text="Snooze for 1 hour — revisit later">
                  <button onClick={() => handlePaneAction("snooze", "snooze")} disabled={acting} className="cursor-pointer rounded px-2.5 py-1 text-xs font-medium bg-amber-800/70 hover:bg-amber-700 text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed">Snooze</button>
                </Tooltip>
                {(workItem.source === "inferred" || workItem.id.startsWith("thread:")) && (
                  <Tooltip text="Create a ticket from this conversation">
                    <CreateTicketButton
                      workItemId={workItemId}
                      disabled={acting}
                      onCreated={() => { onActioned?.(); onClose(); }}
                      onError={setError}
                    />
                  </Tooltip>
                )}
              </div>
            </section>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
