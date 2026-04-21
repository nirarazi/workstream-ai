import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import {
  fetchInbox, fetchAllActive,
  type ActionableItem, type StreamFilter, type Mentionable,
} from "../lib/api";
import FilterTabs from "./stream/FilterTabs";
import StreamListItem from "./stream/StreamListItem";
import StreamDetail from "./stream/StreamDetail";
import { type ActionState } from "./StatusBadge";

const POLL_INTERVAL = 5000;

interface StreamViewProps {
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
}

export default function StreamView({
  mentionables,
  serializeMention,
}: StreamViewProps): JSX.Element {
  const [filter, setFilter] = useState<StreamFilter>("needs-me");
  const [needsMeItems, setNeedsMeItems] = useState<ActionableItem[]>([]);
  const [allActiveItems, setAllActiveItems] = useState<ActionableItem[]>([]);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Map<string, ActionState>>(new Map());
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [inbox, allActive] = await Promise.all([
        fetchInbox(),
        fetchAllActive(),
      ]);
      setNeedsMeItems(inbox.items);
      setAllActiveItems(allActive.items);
      setError(null);

      // Update dock badge count (macOS)
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("plugin:badger|set_count", { count: inbox.items.length });
      } catch { /* not in Tauri */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    }
  }, []);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

  const currentItems = (() => {
    switch (filter) {
      case "needs-me": return needsMeItems;
      case "all-active": return allActiveItems;
      case "snoozed": return needsMeItems.filter(i => i.workItem.snoozedUntil);
    }
  })();

  const snoozedCount = needsMeItems.filter(i => i.workItem.snoozedUntil).length;
  const counts = {
    needsMe: needsMeItems.filter(i => !i.workItem.snoozedUntil).length,
    allActive: allActiveItems.length,
    snoozed: snoozedCount,
  };

  function handleSelect(id: string) {
    setSelectedWorkItemId(prev => prev === id ? null : id);
  }

  const sortedItems = [...currentItems].sort((a, b) => {
    // Pinned items first
    if (a.workItem.pinned && !b.workItem.pinned) return -1;
    if (!a.workItem.pinned && b.workItem.pinned) return 1;
    // Then by latest event timestamp (newest first)
    const tA = a.latestEvent?.timestamp ?? a.workItem.updatedAt;
    const tB = b.latestEvent?.timestamp ?? b.workItem.updatedAt;
    return new Date(tB).getTime() - new Date(tA).getTime();
  });

  return (
    <div className="flex h-full">
      {/* Left panel: list */}
      <div className="w-[45%] min-w-[300px] border-r border-gray-800 flex flex-col overflow-hidden">
        <FilterTabs active={filter} counts={counts} onChange={setFilter} />
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-2 text-xs text-red-400">{error}</div>
          )}
          {sortedItems.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {filter === "needs-me"
                ? "All clear. No items need your attention."
                : filter === "snoozed"
                  ? "No snoozed items."
                  : "No active work items."}
            </div>
          )}
          {sortedItems.map(item => (
            <StreamListItem
              key={item.workItem.id}
              item={item}
              selected={selectedWorkItemId === item.workItem.id}
              actionState={actionStates.get(item.workItem.id) ?? null}
              resolving={resolvingIds.has(item.workItem.id)}
              onSelect={() => handleSelect(item.workItem.id)}
            />
          ))}
        </div>
      </div>

      {/* Right panel: detail */}
      <div className="flex-1 overflow-hidden">
        {selectedWorkItemId ? (
          <StreamDetail
            key={selectedWorkItemId}
            workItemId={selectedWorkItemId}
            mentionables={mentionables}
            serializeMention={serializeMention}
            onActioned={poll}
            onActionStateChange={(id, state) => {
              setActionStates(prev => new Map(prev).set(id, state));
              // Auto-resolve terminal actions after animation completes
              if (state === "unblocked" || state === "done") {
                setResolvingIds(prev => new Set(prev).add(id));
                setTimeout(() => {
                  setResolvingIds(prev => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                }, 2000);
              }
            }}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-gray-500 text-sm">
                {counts.needsMe > 0
                  ? `${counts.needsMe} item${counts.needsMe !== 1 ? "s" : ""} need${counts.needsMe === 1 ? "s" : ""} you`
                  : "All clear"}
              </div>
              <div className="text-gray-700 text-xs mt-1">
                {allActiveItems.length} active across fleet
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
