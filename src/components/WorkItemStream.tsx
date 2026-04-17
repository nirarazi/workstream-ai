import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchStream, postReply, type StreamData } from "../lib/api";
import StatusSnapshot from "./stream/StatusSnapshot";
import Timeline from "./stream/Timeline";
import SuggestedActions from "./stream/SuggestedActions";

interface WorkItemStreamProps {
  workItemId: string;
  onClose: () => void;
  onActioned?: () => void;
}

export default function WorkItemStream({
  workItemId,
  onClose,
  onActioned,
}: WorkItemStreamProps): JSX.Element {
  const [data, setData] = useState<StreamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStream(workItemId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [workItemId]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  function handleActioned() {
    fetchStream(workItemId)
      .then(setData)
      .catch(() => {});
    onActioned?.();
  }

  async function handleReply() {
    if (!replyText.trim() || !data) return;
    setSending(true);
    try {
      await postReply(
        data.latestThreadId ?? undefined,
        data.latestChannelId ?? undefined,
        replyText,
        { workItemId },
      );
      setReplyText("");
      handleActioned();
    } catch {
      // Keep text so the user can retry
    } finally {
      setSending(false);
    }
  }

  if (!data && !error) {
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

  if (error && !data) {
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

  if (!data) return <></>;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" onClick={handleBackdropClick}>
      <div
        ref={paneRef}
        className="w-full max-w-xl bg-gray-950 border-l border-gray-800 overflow-y-auto animate-slide-in-right"
      >
        <div className="absolute top-4 right-4 z-10">
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 cursor-pointer text-lg">&#x2715;</button>
        </div>
        <StatusSnapshot data={data} />
        <Timeline entries={data.timeline} />
        <SuggestedActions data={data} onActioned={handleActioned} />
        <div className="sticky bottom-0 bg-gray-950 border-t border-gray-800 px-5 py-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); } }}
              placeholder="Reply to thread…"
              disabled={sending}
              className="flex-1 bg-black/30 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-cyan-600 disabled:opacity-40"
            />
            <button
              onClick={handleReply}
              disabled={sending || !replyText.trim()}
              className="px-4 py-2 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
            >
              Send
            </button>
          </div>
          {data.latestThreadId && data.channels.length > 0 && (
            <div className="text-[10px] text-gray-600 mt-1">
              → replies to latest thread in #{data.channels[0].name}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
