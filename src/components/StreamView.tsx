import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import {
  fetchInbox, fetchAllActive,
  type ActionableItem, type StreamFilter, type Mentionable,
} from "../lib/api";
import FilterTabs from "./stream/FilterTabs";

const POLL_INTERVAL = 5000;

interface StreamViewProps {
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
}

export default function StreamView({
  mentionables: _mentionables,
  serializeMention: _serializeMention,
}: StreamViewProps): JSX.Element {
  const [filter, setFilter] = useState<StreamFilter>("needs-me");
  const [needsMeItems, setNeedsMeItems] = useState<ActionableItem[]>([]);
  const [allActiveItems, setAllActiveItems] = useState<ActionableItem[]>([]);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
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

  return (
    <div className="flex h-full">
      {/* Left panel: list */}
      <div className="w-[45%] min-w-[300px] border-r border-gray-800 flex flex-col overflow-hidden">
        <FilterTabs active={filter} counts={counts} onChange={setFilter} />
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-2 text-xs text-red-400">{error}</div>
          )}
          {currentItems.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {filter === "needs-me"
                ? "All clear. No items need your attention."
                : filter === "snoozed"
                  ? "No snoozed items."
                  : "No active work items."}
            </div>
          )}
          {/* StreamListItem components will go here in Task 7 */}
          {currentItems.map(item => (
            <div
              key={item.workItem.id}
              onClick={() => handleSelect(item.workItem.id)}
              className={`px-4 py-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-900/50 transition-colors ${
                selectedWorkItemId === item.workItem.id ? "bg-gray-900/80 border-l-2 border-l-cyan-500" : ""
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="text-xs font-semibold text-gray-200">{item.workItem.id}</span>
                <span className="text-[10px] text-gray-500">
                  {item.latestEvent?.timestamp
                    ? new Date(item.latestEvent.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : ""}
                </span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5 truncate">{item.workItem.title}</div>
              <div className="text-[10px] text-gray-600 mt-0.5">{item.agent?.name ?? "Unknown"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel: detail */}
      <div className="flex-1 overflow-hidden">
        {selectedWorkItemId ? (
          <div className="h-full">
            {/* StreamDetail will replace this placeholder in Task 8 */}
            <div className="p-4 text-gray-400 text-sm">
              Detail panel for {selectedWorkItemId}
            </div>
          </div>
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
