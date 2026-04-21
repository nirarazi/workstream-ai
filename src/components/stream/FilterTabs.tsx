import type { StreamFilter } from "../../lib/api";

interface FilterTabsProps {
  active: StreamFilter;
  counts: { needsMe: number; allActive: number; snoozed: number };
  onChange: (filter: StreamFilter) => void;
}

const TABS: { id: StreamFilter; label: string; countKey: keyof FilterTabsProps["counts"] }[] = [
  { id: "needs-me", label: "Needs me", countKey: "needsMe" },
  { id: "all-active", label: "All active", countKey: "allActive" },
  { id: "snoozed", label: "Snoozed", countKey: "snoozed" },
];

export default function FilterTabs({ active, counts, onChange }: FilterTabsProps) {
  return (
    <div className="flex gap-2 px-4 py-2 border-b border-gray-800">
      {TABS.map(({ id, label, countKey }) => {
        const count = counts[countKey];
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
              isActive
                ? "bg-cyan-900/40 text-cyan-400"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`ml-1.5 px-1.5 rounded-full text-[10px] ${
                  isActive ? "bg-cyan-700 text-white" : "bg-gray-700 text-gray-400"
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
