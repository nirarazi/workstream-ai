import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import {
  fetchInbox, fetchAllActive, fetchDismissed, fetchDone, setBadgeCount,
  mergeWorkItems, unmergeWorkItem,
  type ActionableItem, type StreamFilter, type Mentionable,
} from "../lib/api";
import FilterTabs from "./stream/FilterTabs";
import StreamListItem from "./stream/StreamListItem";
import StreamDetail from "./stream/StreamDetail";
import UndoToast from "./stream/UndoToast";
import { type ActionState } from "./StatusBadge";
import { matchesSearch } from "../lib/stream-search";

const POLL_INTERVAL = 5000;

interface StreamViewProps {
  mentionables: Mentionable[];
  serializeMention: (userId: string) => string;
  platform: string;
  platformMeta?: Record<string, unknown>;
  onSyncStateChange?: (state: { lastSyncAt: Date | null; error: boolean }) => void;
}

export default function StreamView({
  mentionables,
  serializeMention,
  platform,
  platformMeta,
  onSyncStateChange,
}: StreamViewProps): JSX.Element {
  const [filter, setFilter] = useState<StreamFilter>("needs-me");
  const [needsMeItems, setNeedsMeItems] = useState<ActionableItem[]>([]);
  const [allActiveItems, setAllActiveItems] = useState<ActionableItem[]>([]);
  const [dismissedItems, setDismissedItems] = useState<ActionableItem[]>([]);
  const [doneItems, setDoneItems] = useState<ActionableItem[]>([]);
  // All finished items: the list itself stops at the latest 200
  const [doneTotal, setDoneTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Map<string, ActionState>>(new Map());
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recentlyViewed, setRecentlyViewed] = useState<
    Array<{ id: string; title: string; channelName?: string; timeAgo?: string }>
  >([]);
  const [undoState, setUndoState] = useState<{
    message: string;
    sourceId: string;
  } | null>(null);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    onSyncStateChange?.({ lastSyncAt, error: syncError });
  }, [lastSyncAt, syncError, onSyncStateChange]);

  const poll = useCallback(async () => {
    try {
      const [inbox, allActive, dismissed, done] = await Promise.all([
        fetchInbox(),
        fetchAllActive(),
        // The Dismissed and Done tabs are secondary: if one fails, keep its last list rather than stall the inbox
        fetchDismissed().catch(() => null),
        fetchDone().catch(() => null),
      ]);
      setNeedsMeItems(inbox.items);
      setAllActiveItems(allActive.items);
      if (dismissed) setDismissedItems(dismissed.items);
      if (done) {
        setDoneItems(done.items);
        setDoneTotal(done.total ?? done.items.length);
      }
      setError(null);
      setLastSyncAt(new Date());
      setSyncError(false);

      setBadgeCount(inbox.items.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
      setSyncError(true);
    }
  }, []);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

  // Track recently viewed items (max 5)
  useEffect(() => {
    if (!selectedWorkItemId) return;
    setRecentlyViewed((prev) => {
      const allItems = [...needsMeItems, ...allActiveItems, ...dismissedItems, ...doneItems];
      const item = allItems.find((i) => i.workItem.id === selectedWorkItemId);
      if (!item) return prev;
      const entry = {
        id: item.workItem.id,
        title: item.workItem.title,
        channelName: item.thread?.channelName,
      };
      const filtered = prev.filter((v) => v.id !== selectedWorkItemId);
      return [entry, ...filtered].slice(0, 5);
    });
  }, [selectedWorkItemId, needsMeItems, allActiveItems, dismissedItems, doneItems]);

  // Needs me already leaves out snoozed items, so the Snoozed tab is drawn from All active
  const snoozedItems = allActiveItems.filter(
    (i) => i.workItem.snoozedUntil && new Date(i.workItem.snoozedUntil).getTime() > Date.now(),
  );
  const tabItems = (() => {
    switch (filter) {
      case "needs-me": return needsMeItems;
      case "snoozed": return snoozedItems;
      case "all-active": return allActiveItems;
      case "done": return doneItems;
      case "dismissed": return dismissedItems;
    }
  })();
  const currentItems = tabItems.filter((i) => matchesSearch(i, search));

  const counts = {
    needsMe: needsMeItems.length,
    snoozed: snoozedItems.length,
    allActive: allActiveItems.length,
    done: doneTotal,
    dismissed: dismissedItems.length,
  };

  function handleSelect(id: string) {
    setSelectedWorkItemId(prev => prev === id ? null : id);
  }

  // Merge handler
  const handleMerge = useCallback(async (sourceId: string, targetId: string) => {
    try {
      setMergingId(sourceId);
      // Start merge animation (300ms)
      await new Promise((r) => setTimeout(r, 300));

      const res = await mergeWorkItems(targetId, sourceId);
      setUndoState({
        message: `Merged into "${[...needsMeItems, ...allActiveItems, ...dismissedItems, ...doneItems].find((i) => i.workItem.id === targetId)?.workItem.title ?? targetId}"`,
        sourceId: res.record.sourceId,
      });

      // Refresh data and select the target after merge
      await poll();
      setSelectedWorkItemId(targetId);
      setMergingId(null);
    } catch (err) {
      console.error("Merge failed", err);
      setMergingId(null);
    }
  }, [needsMeItems, allActiveItems, dismissedItems, doneItems, poll]);

  // Undo handler
  const handleUndo = useCallback(async () => {
    if (!undoState) return;
    try {
      await unmergeWorkItem(undoState.sourceId);
      setUndoState(null);
      await poll();
    } catch (err) {
      console.error("Unmerge failed", err);
    }
  }, [undoState, poll]);

  // Handle drop for drag-to-merge
  const handleDrop = useCallback((targetId: string) => {
    if (draggingId && draggingId !== targetId) {
      handleMerge(draggingId, targetId);
    }
    setDraggingId(null);
    setDragOverId(null);
  }, [draggingId, handleMerge]);

  // Keyboard shortcuts: ⌘Z (undo), M (open merge dropdown), ⇧M (quick merge)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs (includes contentEditable for MentionInput)
      const el = e.target as HTMLElement;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;

      // ⌘Z — undo merge
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && undoState) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // M — open "Merge into..." dropdown (dispatched to detail panel)
      if (e.key === "m" && !e.metaKey && !e.ctrlKey && !e.shiftKey && selectedWorkItemId) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("workstream:open-merge-dropdown"));
        return;
      }

      // ⇧M — instant merge with previously viewed item
      if (e.key === "M" && e.shiftKey && !e.metaKey && !e.ctrlKey && selectedWorkItemId) {
        e.preventDefault();
        const target = recentlyViewed.find((v) => v.id !== selectedWorkItemId);
        if (target) {
          handleMerge(selectedWorkItemId, target.id);
        }
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undoState, handleUndo, selectedWorkItemId, recentlyViewed, handleMerge]);

  const sortedItems = [...currentItems].sort((a, b) => {
    // Dismissed: most recently dismissed first
    if (filter === "dismissed") {
      return new Date(b.workItem.dismissedAt ?? 0).getTime() - new Date(a.workItem.dismissedAt ?? 0).getTime();
    }
    // Done: most recently finished first
    if (filter === "done") {
      const doneAt = (i: ActionableItem) => new Date(i.workItem.statusAt ?? i.workItem.updatedAt).getTime();
      return doneAt(b) - doneAt(a);
    }
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
        <div className="px-4 py-2 border-b border-gray-800">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder="Search ticket, title, agent, channel or message"
            aria-label="Search this tab"
            className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-800"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-2 text-xs text-red-400">{error}</div>
          )}
          {sortedItems.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-gray-600 text-sm">
              {search.trim()
                ? `Nothing matches “${search.trim()}” in this tab.`
                : filter === "needs-me"
                  ? "All clear. No items need your attention."
                  : filter === "snoozed"
                    ? "No snoozed items."
                    : filter === "dismissed"
                      ? "No dismissed items."
                      : filter === "done"
                        ? "Nothing done yet."
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
              mergingAway={mergingId === item.workItem.id}
              onSelect={() => handleSelect(item.workItem.id)}
              onDragStart={setDraggingId}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
              onDrop={handleDrop}
              onDragEnter={(id) => { if (id !== draggingId) setDragOverId(id); }}
              dragOverId={dragOverId}
              showDismissal={filter === "dismissed"}
              showCompletion={filter === "done"}
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
            platform={platform}
            platformMeta={platformMeta}
            onActioned={poll}
            onMerge={(targetId) => handleMerge(selectedWorkItemId, targetId)}
            recentlyViewed={recentlyViewed}
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

      {undoState && (
        <UndoToast
          message={undoState.message}
          onUndo={handleUndo}
          onExpire={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
