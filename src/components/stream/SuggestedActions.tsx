import { useState } from "react";
import type { StreamData } from "../../lib/api";
import { postAction, createTicket, openExternalUrl } from "../../lib/api";

interface SuggestedActionsProps {
  data: StreamData;
  onActioned?: () => void;
}

export default function SuggestedActions({ data, onActioned }: SuggestedActionsProps) {
  const { workItem } = data;
  const [acting, setActing] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBlocked = workItem.currentAtcStatus === "blocked_on_human" || workItem.currentAtcStatus === "needs_decision";
  const isInferred = workItem.source === "inferred" || workItem.id.startsWith("thread:");
  const busy = acting || creatingTicket;

  async function handleAction(serverAction: string, message?: string, duration?: number) {
    setActing(true);
    setError(null);
    try {
      await postAction(workItem.id, serverAction, message, duration);
      onActioned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

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
        {isBlocked && (
          <button
            onClick={() => handleAction("redirect")}
            disabled={busy}
            className="cursor-pointer rounded px-3.5 py-1.5 text-xs font-medium bg-cyan-700/80 hover:bg-cyan-700 text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Unblock
          </button>
        )}
        <button
          onClick={() => handleAction("approve")}
          disabled={busy}
          className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-green-800/70 hover:bg-green-700 text-green-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Done
        </button>
        <button
          onClick={() => handleAction("close")}
          disabled={busy}
          className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-gray-700/70 hover:bg-gray-600 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Dismiss
        </button>
        {[
          { label: "1h", mins: 60 },
          { label: "4h", mins: 240 },
          { label: "Tomorrow", mins: 960 },
        ].map(({ label, mins }) => (
          <button
            key={label}
            onClick={() => handleAction("snooze", undefined, mins)}
            disabled={busy}
            className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-amber-800/70 hover:bg-amber-700 text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {label}
          </button>
        ))}
        {isInferred && (
          <button
            onClick={handleCreateTicket}
            disabled={busy}
            className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-purple-800/70 hover:bg-purple-700 text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creatingTicket ? "..." : "Create Ticket"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
