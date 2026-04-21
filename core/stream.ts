// core/stream.ts — Work Item Stream: aggregated view for the operator

import type { EntryType, OperatorIdentityMap, StatusCategory, Event, WorkItem, Agent, Enrichment } from "./types.js";

export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: StatusCategory;
  timestamp: string;
  agentName: string | null;
  channelName: string;
  summary: string;
  rawText: string;
  isOperator: boolean;
}

export interface StreamData {
  workItem: WorkItem;
  unifiedStatus: string;
  statusSummary: string | null;
  agents: Array<{ id: string; name: string; avatarUrl: string | null }>;
  channels: Array<{ id: string; name: string }>;
  threadCount: number;
  enrichment: Enrichment | null;
  timeline: TimelineEntry[];
  latestThreadId: string | null;
  latestChannelId: string | null;
  nextAction: string | null;
}

export function buildUnifiedStatus(
  workItem: WorkItem,
  latestBlockEvent: Event | null,
  operatorIdentities?: OperatorIdentityMap,
  agentNameMap?: Map<string, string>,
): string {
  if (!workItem.currentAtcStatus) return "Unknown";

  const status = workItem.currentAtcStatus;

  // Resolve the actor-aware label for blocked/decision statuses
  let label: string;

  if (
    latestBlockEvent &&
    (status === "blocked_on_human" || status === "needs_decision") &&
    latestBlockEvent.actionRequiredFrom &&
    latestBlockEvent.actionRequiredFrom.length > 0 &&
    operatorIdentities
  ) {
    // Check if operator is in actionRequiredFrom
    const isOperator = [...operatorIdentities.values()].some(
      (identity) => latestBlockEvent.actionRequiredFrom!.includes(identity.userId),
    );

    if (isOperator) {
      label = status === "needs_decision" ? "Needs your decision" : "Waiting on you";
    } else {
      // Resolve first action taker to a display name
      const firstActorId = latestBlockEvent.actionRequiredFrom[0];
      const actorName = agentNameMap?.get(firstActorId) ?? firstActorId;
      label = status === "needs_decision"
        ? `Needs ${actorName}'s decision`
        : `Waiting on ${actorName}`;
    }
  } else {
    // Fallback to neutral labels when actionRequiredFrom is not available
    const statusLabels: Record<string, string> = {
      blocked_on_human: "Blocked",
      needs_decision: "Needs decision",
      in_progress: "In progress",
      completed: "Completed",
      noise: "No action needed",
    };
    label = statusLabels[status] ?? status;
  }

  // Append waiting time for blocked/decision statuses
  if (
    latestBlockEvent &&
    (status === "blocked_on_human" || status === "needs_decision")
  ) {
    const blockTime = new Date(latestBlockEvent.timestamp);
    const now = new Date();
    const diffMs = now.getTime() - blockTime.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${label} · ${diffMins}m`;
    }
    const diffHours = Math.floor(diffMins / 60);
    const remainMins = diffMins % 60;
    return `${label} · ${diffHours}h ${remainMins}m`;
  }

  return label;
}

export function buildTimeline(
  events: Event[],
  agentMap: Map<string, string>,
  threadChannelMap: Map<string, string>,
): TimelineEntry[] {
  // Events are expected to arrive in oldest-first order (chat style).
  // Preserve input order — do not re-sort.
  return events
    .filter((e) => e.entryType !== "noise")
    .map((e) => ({
      id: e.id,
      entryType: e.entryType,
      status: e.status,
      timestamp: e.timestamp,
      agentName: e.agentId ? (agentMap.get(e.agentId) ?? null) : null,
      channelName: threadChannelMap.get(e.threadId) ?? "",
      summary: e.reason,
      rawText: e.rawText,
      isOperator: e.agentId === null,
    }));
}
