import { useState, useEffect, useRef } from "react";
import { searchWorkItems } from "../../lib/api";

interface MergeTarget {
  id: string;
  title: string;
  channelName?: string;
  timeAgo?: string;
}

interface MergeDropdownProps {
  recentlyViewed: MergeTarget[];
  currentItemId: string;
  onSelect: (targetId: string) => void;
  onClose: () => void;
}

export default function MergeDropdown({ recentlyViewed, currentItemId, onSelect, onClose }: MergeDropdownProps) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MergeTarget[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchWorkItems(query);
        setSearchResults(
          res.items
            .filter((item) => item.id !== currentItemId)
            .map((item) => ({ id: item.id, title: item.title }))
        );
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, currentItemId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredRecent = recentlyViewed.filter((item) => item.id !== currentItemId);
  const showRecent = !query.trim() && filteredRecent.length > 0;
  const items = showRecent ? filteredRecent : searchResults;

  return (
    <div className="absolute right-0 top-full mt-1 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
      {showRecent && (
        <div className="px-3 pt-2 pb-1 text-[11px] text-gray-500 uppercase tracking-wider">
          Recently viewed
        </div>
      )}

      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors flex items-center gap-2"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-200 truncate">{item.title || item.id}</div>
            {item.channelName && (
              <div className="text-[11px] text-gray-500">{item.channelName}{item.timeAgo ? ` · ${item.timeAgo}` : ""}</div>
            )}
          </div>
        </button>
      ))}

      {query.trim() && items.length === 0 && !searching && (
        <div className="px-3 py-3 text-sm text-gray-500 text-center">No matches</div>
      )}
      {searching && (
        <div className="px-3 py-3 text-sm text-gray-500 text-center">Searching…</div>
      )}

      <div className="border-t border-gray-700 p-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search work items..."
          className="w-full bg-gray-950 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500"
        />
      </div>
    </div>
  );
}
