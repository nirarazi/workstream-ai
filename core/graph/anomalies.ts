export interface FleetItemInput {
  workItemId: string;
  currentAtcStatus: string | null;
  latestEventTimestamp: string;
  agentLastSeen: string | null;
  eventStatuses: string[];
  title: string;
}

export interface AnomalyFlag {
  type: "stale" | "silent_agent" | "status_regression" | "duplicate_work";
  message: string;
}

export interface AnomalyConfig {
  staleThresholdHours: number;
  silentAgentThresholdHours: number;
}

export function detectAnomalies(
  item: FleetItemInput,
  otherItems: FleetItemInput[],
  config: AnomalyConfig,
  now: Date = new Date(),
): AnomalyFlag[] {
  const anomalies: AnomalyFlag[] = [];
  const nowMs = now.getTime();

  // Stale: no new events for >threshold hours on an active item
  const activeStatuses = new Set(["in_progress", "blocked_on_human", "needs_decision"]);
  if (activeStatuses.has(item.currentAtcStatus ?? "")) {
    const lastEventMs = new Date(item.latestEventTimestamp).getTime();
    const hoursSinceEvent = (nowMs - lastEventMs) / (1000 * 60 * 60);
    if (hoursSinceEvent > config.staleThresholdHours) {
      anomalies.push({
        type: "stale",
        message: `No activity for ${Math.floor(hoursSinceEvent)}h`,
      });
    }
  }

  // Silent agent: agent's last_seen is >threshold while they have active work
  if (
    activeStatuses.has(item.currentAtcStatus ?? "") &&
    item.agentLastSeen
  ) {
    const agentLastMs = new Date(item.agentLastSeen).getTime();
    const hoursSinceAgent = (nowMs - agentLastMs) / (1000 * 60 * 60);
    if (hoursSinceAgent > config.silentAgentThresholdHours) {
      anomalies.push({
        type: "silent_agent",
        message: `Agent silent for ${Math.floor(hoursSinceAgent)}h`,
      });
    }
  }

  // Status regression: went from in_progress/completed back to blocked
  if (item.eventStatuses.length >= 2) {
    const current = item.eventStatuses[item.eventStatuses.length - 1];
    const previous = item.eventStatuses.slice(0, -1);
    const progressedBefore =
      previous.includes("in_progress") || previous.includes("completed");
    const regressedNow =
      current === "blocked_on_human" || current === "needs_decision";

    if (progressedBefore && regressedNow) {
      anomalies.push({
        type: "status_regression",
        message: "Status regressed to blocked",
      });
    }
  }

  // Duplicate work: same non-empty title as another active item
  if (item.title && item.title.length > 0) {
    const duplicate = otherItems.find(
      (other) =>
        other.workItemId !== item.workItemId &&
        other.title === item.title &&
        activeStatuses.has(other.currentAtcStatus ?? ""),
    );
    if (duplicate) {
      anomalies.push({
        type: "duplicate_work",
        message: `Same title as ${duplicate.workItemId}`,
      });
    }
  }

  return anomalies;
}
