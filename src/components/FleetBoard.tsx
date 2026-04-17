import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchFleet, fetchAgents, agentsToMentionables, type FleetItem, type Agent, type Mentionable } from "../lib/api";
import { timeAgo } from "../lib/time";
import StatusBadge from "./StatusBadge";
import FleetFilters from "./FleetFilters";
import ContextPane from "./ContextPane";

const POLL_INTERVAL = 10000;

interface FleetBoardProps {
  platformMeta?: Record<string, unknown>;
}

const ANOMALY_ICONS: Record<string, { icon: string; color: string }> = {
  stale: { icon: "\u23F0", color: "text-amber-400" },
  silent_agent: { icon: "\u26A0", color: "text-red-400" },
  status_regression: { icon: "\u2193", color: "text-red-400" },
  duplicate_work: { icon: "\uD83D\uDD17", color: "text-purple-400" },
};

export default function FleetBoard({ platformMeta }: FleetBoardProps): JSX.Element {
  const [items, setItems] = useState<FleetItem[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map());
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [agentFilter, setAgentFilter] = useState<string[]>([]);
  const [anomalyOnly, setAnomalyOnly] = useState(false);

  // Context pane state
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const [fleetRes, agentsRes] = await Promise.all([fetchFleet(), fetchAgents()]);
      setItems(fleetRes.items);
      setAgents(agentsRes.agents);

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

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [poll]);

  // Client-side filtering
  const filtered = items.filter((item) => {
    const q = searchQuery.toLowerCase();
    if (q) {
      const matchesSearch =
        item.workItem.id.toLowerCase().includes(q) ||
        item.workItem.title.toLowerCase().includes(q) ||
        (item.agent?.name ?? "").toLowerCase().includes(q);
      if (!matchesSearch) return false;
    }
    if (statusFilter.length > 0 && !statusFilter.includes(item.workItem.currentAtcStatus ?? "")) {
      return false;
    }
    if (agentFilter.length > 0 && (!item.agent || !agentFilter.includes(item.agent.id))) {
      return false;
    }
    if (anomalyOnly && item.anomalies.length === 0) {
      return false;
    }
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading fleet...</p>
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

  return (
    <div>
      <FleetFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
        anomalyOnly={anomalyOnly}
        onAnomalyOnlyChange={setAnomalyOnly}
        agents={agents}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-3 py-2">Work Item</th>
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 hidden md:table-cell">External</th>
              <th className="px-3 py-2">Last Activity</th>
              <th className="px-3 py-2">Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr
                key={item.workItem.id}
                onClick={() => setSelectedWorkItemId(item.workItem.id)}
                className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer transition-colors"
              >
                <td className="px-3 py-2.5">
                  {!item.workItem.id.startsWith("thread:") && (
                    <span className="font-mono text-sm font-semibold text-cyan-400">
                      {item.workItem.id}
                    </span>
                  )}
                  {item.workItem.title ? (
                    <p className={`text-xs truncate max-w-48 ${item.workItem.id.startsWith("thread:") ? "text-sm font-semibold text-gray-200" : "text-gray-400"}`}>
                      {item.workItem.title}
                    </p>
                  ) : item.workItem.id.startsWith("thread:") ? (
                    <span className="text-sm font-semibold text-gray-400">Untitled conversation</span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  {item.agent ? (
                    <div className="flex items-center gap-2">
                      {item.agent.avatarUrl ? (
                        <img src={item.agent.avatarUrl} className="h-5 w-5 rounded-full" />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-700 text-xs text-gray-400">
                          {item.agent.name.charAt(0)}
                        </span>
                      )}
                      <span className="text-xs text-gray-300">{item.agent.name}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-600">&mdash;</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={item.workItem.currentAtcStatus ?? "noise"} />
                </td>
                <td className="px-3 py-2.5 hidden md:table-cell">
                  <span className="text-xs text-gray-500">
                    {item.workItem.externalStatus ?? "\u2014"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-gray-500">
                    {item.latestEvent ? timeAgo(item.latestEvent.timestamp) : "\u2014"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    {item.anomalies.map((anomaly, i) => {
                      const config = ANOMALY_ICONS[anomaly.type] ?? { icon: "?", color: "text-gray-400" };
                      return (
                        <span
                          key={i}
                          className={`text-xs ${config.color}`}
                          title={anomaly.message}
                        >
                          {config.icon}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-500">
            {items.length === 0 ? "No active work items." : "No items match filters."}
          </p>
        </div>
      )}

      {/* Shared context pane */}
      {selectedWorkItemId && (
        <ContextPane
          workItemId={selectedWorkItemId}
          platformMeta={platformMeta}
          userMap={userMap}
          mentionables={mentionables}
          onClose={() => setSelectedWorkItemId(null)}
          onActioned={() => setTimeout(poll, 500)}
        />
      )}
    </div>
  );
}
