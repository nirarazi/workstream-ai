import { useEffect, useRef, type JSX } from "react";
import type { Mentionable } from "../lib/api";

interface MentionDropdownProps {
  query: string;
  mentionables: Mentionable[];
  selectedIndex: number;
  onSelect: (m: Mentionable) => void;
}

const MAX_VISIBLE = 6;

export default function MentionDropdown({
  query,
  mentionables,
  selectedIndex,
  onSelect,
}: MentionDropdownProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null);

  // Filter by query (case-insensitive prefix match on name)
  const q = query.toLowerCase();
  const filtered = q
    ? mentionables.filter((m) => m.name.toLowerCase().includes(q))
    : mentionables;

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-52 overflow-y-auto rounded border border-gray-700 bg-gray-800 shadow-lg z-50"
      style={{ maxHeight: MAX_VISIBLE * 40 }}
    >
      {filtered.map((m, i) => (
        <button
          key={m.id}
          type="button"
          onMouseDown={(e) => {
            // Use mouseDown (not click) to fire before contentEditable blur
            e.preventDefault();
            onSelect(m);
          }}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm cursor-pointer ${
            i === selectedIndex
              ? "bg-blue-900/60 text-blue-200"
              : "text-gray-300 hover:bg-gray-700"
          }`}
        >
          {m.avatarUrl ? (
            <img src={m.avatarUrl} alt="" className="h-5 w-5 rounded-full shrink-0" />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-600 text-[10px] font-semibold text-gray-300 shrink-0">
              {m.name.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="truncate">{m.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Filter mentionables by query — exported for use in parent keyboard handling */
export function filterMentionables(mentionables: Mentionable[], query: string): Mentionable[] {
  const q = query.toLowerCase();
  return q
    ? mentionables.filter((m) => m.name.toLowerCase().includes(q))
    : mentionables;
}
