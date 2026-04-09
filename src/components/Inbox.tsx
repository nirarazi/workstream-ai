import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchInbox, fetchRecent, fetchAgents, agentsToMentionables, setBadgeCount, type ActionableItem, type Mentionable } from "../lib/api";
import WorkItemCard from "./WorkItemCard";
import ContextPane from "./ContextPane";

const POLL_INTERVAL = 5000;

interface InboxProps {
  platformMeta?: Record<string, unknown>;
}

export default function Inbox({ platformMeta }: InboxProps): JSX.Element {
  const [actionable, setActionable] = useState<ActionableItem[]>([]);
  const [recent, setRecent] = useState<ActionableItem[]>([]);
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map());
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [inboxRes, recentRes, agentsRes] = await Promise.all([
        fetchInbox(),
        fetchRecent(20),
        fetchAgents(),
      ]);
      setActionable(inboxRes.items);
      setRecent(recentRes.items);
      setBadgeCount(inboxRes.items.length);

      const map = new Map<string, string>();
      for (const a of agentsRes.agents) {
        if (a.platformUserId) map.set(a.platformUserId, a.name);
      }
      setUserMap(map);
      setMentionables(agentsToMentionables(agentsRes.agents));

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleActioned = useCallback(() => {
    setTimeout(() => poll(), 500);
  }, [poll]);

  const handleSelect = useCallback((workItemId: string) => {
    setSelectedWorkItemId((prev) => (prev === workItemId ? null : workItemId));
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
        <p className="text-sm text-gray-500">Loading stream...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm text-red-400">Unable to reach the workstream.ai engine.</p>
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
      {hasActionable && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Needs Attention
          </h2>
          <div className="space-y-3">
            {actionable.map((item) => (
              <WorkItemCard key={item.workItem.id + item.latestEvent.id} item={item} platformMeta={platformMeta} userMap={userMap} mentionables={mentionables} onActioned={handleActioned} onSelect={handleSelect} />
            ))}
          </div>
        </section>
      )}

      {hasRecent && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Recent
          </h2>
          <div className="space-y-3">
            {recent.map((item) => (
              <WorkItemCard key={item.workItem.id + item.latestEvent.id} item={item} platformMeta={platformMeta} userMap={userMap} mentionables={mentionables} onActioned={handleActioned} onSelect={handleSelect} />
            ))}
          </div>
        </section>
      )}

      {selectedWorkItemId && (
        <ContextPane
          workItemId={selectedWorkItemId}
          platformMeta={platformMeta}
          userMap={userMap}
          mentionables={mentionables}
          onClose={() => setSelectedWorkItemId(null)}
          onActioned={handleActioned}
        />
      )}
    </div>
  );
}
