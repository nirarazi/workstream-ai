import { useState, useEffect, useRef, useCallback, useMemo, type JSX } from "react";
import { fetchInbox, fetchAgents, agentsToMentionables, setBadgeCount, type ActionableItem, type Mentionable } from "../lib/api";
import WorkItemCard from "./WorkItemCard";
import WorkItemStream from "./WorkItemStream";
import { getSerializeMention } from "../messaging/registry";

const POLL_INTERVAL = 5000;

interface StreamProps {
  platformMeta?: Record<string, unknown>;
}

export default function Stream({ platformMeta }: StreamProps): JSX.Element {
  const [items, setItems] = useState<ActionableItem[]>([]);
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map());
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [inboxRes, agentsRes] = await Promise.all([
        fetchInbox(),
        fetchAgents(),
      ]);
      setItems(inboxRes.items);
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

  const platform = items[0]?.thread?.platform ?? "slack";
  const serializeMention = useMemo(() => getSerializeMention(platform), [platform]);

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

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-400">
          All clear. No items need your attention.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <WorkItemCard key={item.workItem.id + item.latestEvent.id} item={item} platformMeta={platformMeta} userMap={userMap} mentionables={mentionables} onActioned={handleActioned} onSelect={handleSelect} />
      ))}

      {selectedWorkItemId && (
        <WorkItemStream
          workItemId={selectedWorkItemId}
          mentionables={mentionables}
          serializeMention={serializeMention}
          onClose={() => setSelectedWorkItemId(null)}
          onActioned={handleActioned}
        />
      )}
    </div>
  );
}
