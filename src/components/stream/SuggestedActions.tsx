import { useState } from "react";
import type { StreamData } from "../../lib/api";
import { postAction } from "../../lib/api";

interface SuggestedActionsProps {
  data: StreamData;
  onActioned?: () => void;
}

export default function SuggestedActions({ data, onActioned }: SuggestedActionsProps) {
  const { workItem } = data;
  const [acting, setActing] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Suggested Actions</div>
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">✅ Approve</div>
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
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 mb-2 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-1">✏️ Request changes</div>
        <div className="text-xs text-gray-600 mb-2">→ replies to latest thread</div>
        <input
          type="text"
          value={editMessage}
          onChange={(e) => setEditMessage(e.target.value)}
          placeholder="What changes do you need?"
          className="w-full bg-black/30 border border-gray-700 rounded-md px-2.5 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-cyan-600 mb-2"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => handleAction("redirect", editMessage)}
            disabled={acting || !editMessage.trim()}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-gray-950 hover:bg-cyan-500 disabled:opacity-40 cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>
      <div className="bg-white/[0.03] border border-gray-800 rounded-lg p-3 hover:border-cyan-600/30 transition-colors">
        <div className="font-medium text-sm text-gray-200 mb-2">💤 Snooze</div>
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
              className="px-3 py-1.5 rounded-md text-xs bg-white/[0.05] border border-gray-800 text-gray-500 hover:text-gray-300 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40"
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
