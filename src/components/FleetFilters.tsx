import { useState, useRef, useEffect, type JSX } from "react";
import type { Agent } from "../lib/api";

interface FleetFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: string[];
  onStatusFilterChange: (statuses: string[]) => void;
  agentFilter: string[];
  onAgentFilterChange: (agentIds: string[]) => void;
  anomalyOnly: boolean;
  onAnomalyOnlyChange: (value: boolean) => void;
  agents: Agent[];
}

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In Progress" },
  { value: "blocked_on_human", label: "Blocked" },
  { value: "needs_decision", label: "Needs Decision" },
  { value: "noise", label: "Noise" },
];

function AgentMultiSelect({
  agents,
  selected,
  onChange,
}: {
  agents: Agent[];
  selected: string[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((a) => a !== id)
        : [...selected, id],
    );
  }

  const selectedNames = agents
    .filter((a) => selected.includes(a.id))
    .map((a) => a.name);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`cursor-pointer flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors ${
          selected.length > 0
            ? "bg-cyan-900/60 text-cyan-300 border-cyan-700/50"
            : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
        }`}
      >
        <span>
          {selected.length === 0
            ? "Agents"
            : selected.length === 1
              ? selectedNames[0]
              : `${selected.length} agents`}
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            className="ml-0.5 hover:text-cyan-100"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            ×
          </span>
        )}
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-48 rounded border border-gray-700 bg-gray-900 py-1 shadow-lg max-h-56 overflow-y-auto">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => toggle(agent.id)}
              className="cursor-pointer flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
            >
              <span
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                  selected.includes(agent.id)
                    ? "bg-cyan-600 border-cyan-500 text-white"
                    : "border-gray-600"
                }`}
              >
                {selected.includes(agent.id) && "✓"}
              </span>
              {agent.avatarUrl ? (
                <img
                  src={agent.avatarUrl}
                  alt=""
                  className="h-4 w-4 rounded-full"
                />
              ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-[9px] text-gray-400">
                  {agent.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FleetFilters({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  agentFilter,
  onAgentFilterChange,
  anomalyOnly,
  onAnomalyOnlyChange,
  agents,
}: FleetFiltersProps): JSX.Element {
  function toggleStatus(status: string) {
    if (statusFilter.includes(status)) {
      onStatusFilterChange(statusFilter.filter((s) => s !== status));
    } else {
      onStatusFilterChange([...statusFilter, status]);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      {/* Search */}
      <input
        type="text"
        placeholder="Search work items..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-cyan-600 focus:outline-none w-56"
      />

      {/* Status filter pills */}
      <div className="flex items-center gap-1">
        {STATUS_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => toggleStatus(value)}
            className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
              statusFilter.includes(value)
                ? "bg-cyan-900/60 text-cyan-300 border-cyan-700/50"
                : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Agent filter */}
      {agents.length > 0 && (
        <AgentMultiSelect
          agents={agents}
          selected={agentFilter}
          onChange={onAgentFilterChange}
        />
      )}

      {/* Anomaly-only toggle */}
      <button
        onClick={() => onAnomalyOnlyChange(!anomalyOnly)}
        className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
          anomalyOnly
            ? "bg-red-900/60 text-red-300 border-red-700/50"
            : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
        }`}
      >
        Anomalies only
      </button>
    </div>
  );
}
