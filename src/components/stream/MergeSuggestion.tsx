import { useState, useEffect } from "react";

interface MergeSuggestionProps {
  currentItemId: string;
  currentChannelName: string;
  recentlyViewed: Array<{
    id: string;
    title: string;
    channelName?: string;
  }>;
  onMerge: (targetId: string) => void;
}

// Track dismissed pairs so they don't reappear
const dismissedPairs = new Set<string>();

function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export default function MergeSuggestion({
  currentItemId,
  currentChannelName,
  recentlyViewed,
  onMerge,
}: MergeSuggestionProps) {
  const [dismissed, setDismissed] = useState(false);

  // Find a recently viewed item from the same channel
  const suggestion = recentlyViewed.find(
    (item) =>
      item.id !== currentItemId &&
      item.channelName === currentChannelName &&
      !dismissedPairs.has(pairKey(currentItemId, item.id))
  );

  useEffect(() => {
    setDismissed(false);
  }, [currentItemId]);

  if (!suggestion || dismissed) return null;

  return (
    <div className="bg-gradient-to-r from-purple-900/20 to-purple-800/10 border border-purple-500/20 rounded-lg px-4 py-3 mb-4 flex items-center gap-3 animate-list-enter">
      <span className="text-lg">🔗</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-purple-300">Same conversation?</div>
        <div className="text-[11px] text-gray-300 mt-0.5 truncate">
          You were just viewing "<span className="text-gray-100">{suggestion.title || suggestion.id}</span>" in the same channel
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => onMerge(suggestion.id)}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition-colors"
        >
          Merge
        </button>
        <button
          onClick={() => {
            dismissedPairs.add(pairKey(currentItemId, suggestion.id));
            setDismissed(true);
          }}
          className="px-1.5 py-1.5 text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
