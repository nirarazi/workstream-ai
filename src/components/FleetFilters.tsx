import { type JSX } from "react";
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

  function toggleAgent(agentId: string) {
    if (agentFilter.includes(agentId)) {
      onAgentFilterChange(agentFilter.filter((a) => a !== agentId));
    } else {
      onAgentFilterChange([...agentFilter, agentId]);
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
        className="rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-600 focus:outline-none w-56"
      />

      {/* Status filter pills */}
      <div className="flex items-center gap-1">
        {STATUS_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => toggleStatus(value)}
            className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
              statusFilter.includes(value)
                ? "bg-blue-900/60 text-blue-300 border-blue-700/50"
                : "bg-gray-900 text-gray-500 border-gray-700 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Agent filter dropdown */}
      {agents.length > 0 && (
        <select
          multiple
          value={agentFilter}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions, (o) => o.value);
            onAgentFilterChange(selected);
          }}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300 max-h-24 overflow-y-auto"
          title="Filter by agent"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
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
