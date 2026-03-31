import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchInbox, fetchRecent, type ActionableItem } from "../lib/api";
import WorkItemCard from "./WorkItemCard";

const POLL_INTERVAL = 5000;

export default function Inbox(): JSX.Element {
  const [actionable, setActionable] = useState<ActionableItem[]>([]);
  const [recent, setRecent] = useState<ActionableItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [inboxRes, recentRes] = await Promise.all([
        fetchInbox(),
        fetchRecent(20),
      ]);
      setActionable(inboxRes.items);
      setRecent(recentRes.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading inbox...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm text-red-400">Unable to reach the ATC engine.</p>
        <p className="text-xs text-gray-500">{error}</p>
      </div>
    );
  }

  const hasActionable = actionable.length > 0;
  const hasRecent = recent.length > 0;

  if (!hasActionable && !hasRecent) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-400">
          All clear. No items need your attention.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Actionable items */}
      {hasActionable && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Needs Attention
          </h2>
          <div className="space-y-3">
            {actionable.map((item) => (
              <WorkItemCard key={item.workItem.id + item.latestEvent.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Recent items */}
      {hasRecent && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Recent
          </h2>
          <div className="space-y-3">
            {recent.map((item) => (
              <WorkItemCard key={item.workItem.id + item.latestEvent.id} item={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
