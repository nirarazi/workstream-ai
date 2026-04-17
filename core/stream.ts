// core/stream.ts — Work Item Stream: aggregated view for the operator

import type { EntryType, StatusCategory, Event, WorkItem, Agent, Enrichment } from "./types.js";

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
  quickReplies: string[];
}

export function buildUnifiedStatus(
  workItem: WorkItem,
  latestBlockEvent: Event | null,
): string {
  if (!workItem.currentAtcStatus) return "Unknown";

  const statusLabels: Record<string, string> = {
    blocked_on_human: "Waiting on you",
    needs_decision: "Needs your decision",
    in_progress: "In progress",
    completed: "Completed",
    noise: "No action needed",
  };

  const label = statusLabels[workItem.currentAtcStatus] ?? workItem.currentAtcStatus;

  if (
    latestBlockEvent &&
    (workItem.currentAtcStatus === "blocked_on_human" ||
      workItem.currentAtcStatus === "needs_decision")
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
    }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
