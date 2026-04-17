import { useState, useRef } from "react";
import type { StreamData, Mentionable } from "../../lib/api";
import { postAction } from "../../lib/api";
import MentionInput, { type MentionInputHandle } from "../MentionInput";

interface SuggestedActionsProps {
  data: StreamData;
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
  onActioned?: () => void;
}

export default function SuggestedActions({ data, mentionables, serializeMention, onActioned }: SuggestedActionsProps) {
  const { workItem } = data;
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editInputRef = useRef<MentionInputHandle>(null);

  const isBlocked = workItem.currentAtcStatus === "blocked_on_human" || workItem.currentAtcStatus === "needs_decision";
  if (!isBlocked) return null;

  async function handleAction(action: string, message?: string, duration?: number) {
    setActing(true);
    setError(null);
    try {
      await postAction(workItem.id, action, message, duration);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  function handleRequestChanges() {
    const text = editInputRef.current?.serialize() ?? "";
    if (!text.trim()) return;
    handleAction("redirect", text);
  }

  return (
    <div className="px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Suggested Actions</div>
      <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">Approve</div>
        <div className="text-xs text-gray-600 mb-2">→ replies to latest thread</div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => handleAction("approve", "Approved. Go ahead.")}
            disabled={acting}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>
      <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">Request changes</div>
        <div className="text-xs text-gray-600 mb-2">→ replies to latest thread</div>
        <MentionInput
          ref={editInputRef}
          placeholder="What changes do you need?"
          disabled={acting}
          mentionables={mentionables}
          serializeMention={serializeMention}
          onSubmit={(text) => handleAction("redirect", text)}
        />
        <div className="flex gap-2 justify-end mt-2">
          <button
            onClick={handleRequestChanges}
            disabled={acting}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>
      <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-3 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-2">Snooze</div>
        <div className="flex gap-1.5">
          {[
            { label: "1h", mins: 60 },
            { label: "4h", mins: 240 },
            { label: "Tomorrow", mins: 960 },
          ].map(({ label, mins }) => (
            <button
              key={label}
              onClick={() => handleAction("snooze", undefined, mins)}
              disabled={acting}
              className="px-3 py-1.5 rounded-md text-xs bg-gray-900/60 border border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-800 cursor-pointer disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
