import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import {
  fetchStream, postReply, togglePin,
  type StreamData, type Mentionable,
} from "../../lib/api";
import { type ActionState } from "../StatusBadge";
import StatusSnapshot from "./StatusSnapshot";
import Timeline from "./Timeline";
import SuggestedActions from "./SuggestedActions";
import MentionInput, { type MentionInputHandle } from "../MentionInput";
import SendConfirmation from "./SendConfirmation";
import DoneCelebration from "./DoneCelebration";
import MergeSuggestion from "./MergeSuggestion";

interface StreamDetailProps {
  workItemId: string;
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
  platformMeta?: Record<string, unknown>;
  onActioned?: () => void;
  onActionStateChange?: (workItemId: string, state: ActionState) => void;
  onMerge?: (targetId: string) => void;
  recentlyViewed?: Array<{ id: string; title: string; channelName?: string; timeAgo?: string }>;
}

export default function StreamDetail({
  workItemId,
  mentionables,
  serializeMention,
  platformMeta,
  onActioned,
  onActionStateChange,
  onMerge,
  recentlyViewed,
}: StreamDetailProps): JSX.Element {
  const [data, setData] = useState<StreamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [replySent, setReplySent] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: string; channelName: string } | null>(null);
  const [showDoneCelebration, setShowDoneCelebration] = useState(false);
  const [inputFlash, setInputFlash] = useState(false);
  const replyInputRef = useRef<MentionInputHandle>(null);

  // Fetch stream data on mount / workItemId change
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchStream(workItemId, { limit: 10 })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [workItemId]);

  // Load older messages
  const handleLoadOlder = useCallback(async () => {
    if (!data || data.timeline.length === 0) return;
    const oldestTimestamp = data.timeline[0].timestamp;
    try {
      const older = await fetchStream(workItemId, { limit: 10, before: oldestTimestamp });
      setData((prev) => {
        if (!prev) return older;
        return {
          ...prev,
          timeline: [...older.timeline, ...prev.timeline],
          hasOlder: older.hasOlder,
        };
      });
    } catch {
      // Silently ignore — user can retry
    }
  }, [data, workItemId]);

  // Refresh after action
  function handleActioned() {
    fetchStream(workItemId, { limit: 10 })
      .then(setData)
      .catch(() => {});
    onActioned?.();
  }

  function getReplyText(): string | undefined {
    return replyInputRef.current?.serialize() || undefined;
  }

  function handleActionComplete(action: string) {
    replyInputRef.current?.clear();
    // Map action types to ActionState for the list
    let state: ActionState = null;
    switch (action) {
      case "redirect":
      case "unblock":
        state = "unblocked";
        break;
      case "approve":
      case "done":
        state = "done";
        break;
      case "snooze":
        state = "snoozed";
        break;
    }
    if (state) {
      onActionStateChange?.(workItemId, state);
    }
    // Show celebration for "done"
    if (state === "done") {
      setShowDoneCelebration(true);
    }
    // Show confirmation for actions that send a reply to the channel
    if (state === "unblocked" || state === "done") {
      const channelName = data?.channels[0]?.name ?? "thread";
      setConfirmation({ action, channelName });
    }
  }

  async function handleReply(serializedText: string) {
    if (!serializedText.trim() || !data) return;
    setSending(true);
    setReplySent(false);
    try {
      await postReply(
        data.latestThreadId ?? undefined,
        data.latestChannelId ?? undefined,
        serializedText,
        { workItemId },
      );
      replyInputRef.current?.clear();
      setSending(false);
      setReplySent(true);
      setTimeout(() => setReplySent(false), 2000);
      onActionStateChange?.(workItemId, "replied");
      handleActioned();
    } catch {
      setSending(false);
      // Keep text so the user can retry
    }
  }

  async function handleTogglePin() {
    if (!data) return;
    try {
      const result = await togglePin(workItemId);
      setData((prev) =>
        prev
          ? { ...prev, workItem: { ...prev.workItem, pinned: result.pinned } }
          : prev,
      );
      onActioned?.();
    } catch {
      // Silently ignore
    }
  }

  // Loading skeleton
  if (!data && !error) {
    return (
      <div className="h-full flex flex-col bg-gray-950">
        <div className="px-5 py-4 border-b border-gray-800">
          <div className="h-4 w-24 bg-gray-800 rounded animate-pulse mb-2" />
          <div className="h-6 w-48 bg-gray-800 rounded animate-pulse mb-3" />
          <div className="h-5 w-20 bg-gray-800 rounded animate-pulse" />
        </div>
        <div className="flex-1 px-4 py-3 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-2.5">
              <div className="w-7 h-7 rounded-full bg-gray-800 animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 bg-gray-800 rounded animate-pulse" />
                <div className="h-14 bg-gray-800/50 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error && !data) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <p className="text-sm text-red-400 mb-2">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchStream(workItemId, { limit: 10 })
                .then(setData)
                .catch((err) => setError(err.message));
            }}
            className="cursor-pointer text-xs text-gray-400 hover:text-gray-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return <></>;

  return (
    <div className="h-full flex flex-col bg-gray-950 relative">
      {/* Done celebration overlay */}
      {showDoneCelebration && (
        <DoneCelebration onComplete={() => setShowDoneCelebration(false)} />
      )}

      {/* Header */}
      <StatusSnapshot
        data={data}
        pinned={data.workItem.pinned}
        platformMeta={platformMeta}
        onTogglePin={handleTogglePin}
      />

      {/* Merge suggestion */}
      {onMerge && recentlyViewed && data && (
        <div className="px-5 pt-2">
          <MergeSuggestion
            currentItemId={workItemId}
            currentChannelName={data.channels?.[0]?.name ?? ""}
            recentlyViewed={recentlyViewed}
            onMerge={onMerge}
          />
        </div>
      )}

      {/* Timeline (flex-1 to fill available space) */}
      <Timeline
        entries={data.timeline}
        hasOlder={data.hasOlder}
        platformMeta={platformMeta}
        mentionables={mentionables}
        workItemId={workItemId}
        onLoadOlder={handleLoadOlder}
      />

      {/* Actions + Reply (sticky bottom) */}
      <div className="border-t border-gray-800">
        {confirmation ? (
          <SendConfirmation
            channelName={confirmation.channelName}
            action={confirmation.action}
            onComplete={() => setConfirmation(null)}
          />
        ) : (
          <>
            <SuggestedActions
              data={data}
              onActioned={handleActioned}
              getReplyText={getReplyText}
              onActionComplete={handleActionComplete}
              pinned={data.workItem.pinned}
              onTogglePin={handleTogglePin}
              onMerge={onMerge}
              recentlyViewed={recentlyViewed}
              workItemId={workItemId}
            />
            <div className={`px-5 pb-3 ${inputFlash ? "animate-input-success rounded" : ""}`}>
              <div className="relative">
                <MentionInput
                  ref={replyInputRef}
                  placeholder="Reply to thread..."
                  disabled={sending}
                  mentionables={mentionables}
                  serializeMention={serializeMention}
                  onSubmit={handleReply}
                />
                {/* Sending overlay */}
                {sending && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-800/90 rounded border border-gray-700 animate-reply-sending">
                    <div className="flex items-center gap-2 text-sm text-gray-300">
                      <span className="animate-reply-dots flex gap-0.5">
                        <span className="reply-dot" />
                        <span className="reply-dot" />
                        <span className="reply-dot" />
                      </span>
                      <span>Sending to #{data.channels[0]?.name ?? "thread"}</span>
                    </div>
                  </div>
                )}
                {/* Sent confirmation overlay */}
                {replySent && !sending && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-800/90 rounded border border-green-700/50 animate-reply-sent">
                    <div className="flex items-center gap-2 text-sm text-green-400 font-medium">
                      <svg className="w-4 h-4 animate-reply-check" viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Sent to #{data.channels[0]?.name ?? "thread"}</span>
                    </div>
                  </div>
                )}
              </div>
              {!sending && !replySent && data.latestThreadId && data.channels.length > 0 && (
                <div className="text-[10px] text-gray-600 mt-1">
                  replies to latest thread in #{data.channels[0].name}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
