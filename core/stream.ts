// core/stream.ts — Work Item Stream: aggregated view for the operator

import type { EntryType, OperatorIdentityMap, StatusCategory, Event, WorkItem, Enrichment } from "./types.js";

export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: StatusCategory;
  timestamp: string;
  agentId: string | null;
  agentName: string | null;
  agentAvatarUrl: string | null;
  channelId: string;
  channelName: string;
  threadId: string;
  platform: string;
  summary: string;
  rawText: string;
  isOperator: boolean;
  relation?: "primary" | "mentioned";
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

/** Longest name shown in a status label; anything longer is more likely model prose than a name. */
const MAX_LABEL_NAME_LENGTH = 40;

/**
 * A platform user ID, mention token or similar (e.g. U0OPERATOR1, <@U0OPERATOR1>, 1712345678.123456),
 * not a readable name. An all-caps agent name with a digit (say R2D2) counts too, so such a name is
 * only shown once the graph or the platform's directory supplies it.
 */
function looksLikeOpaqueId(value: string): boolean {
  return (/\d/.test(value) && /^[A-Z0-9_.:-]+$/.test(value)) || /^<.*>$/.test(value);
}

/** The value if it's fit to show as a person's name: not an ID (or the ID itself), not "unknown", not too long. */
export function usableName(value: string | null | undefined, id?: string): string | null {
  const name = value?.trim();
  if (!name || name === id || name.toLowerCase() === "unknown") return null;
  if (looksLikeOpaqueId(name) || name.length > MAX_LABEL_NAME_LENGTH) return null;
  return name;
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
    // Check if operator is in actionRequiredFrom, by ID or, when the classifier wrote a name, by name
    const isOperator = [...operatorIdentities.values()].some((identity) =>
      latestBlockEvent.actionRequiredFrom!.some(
        (actor) => actor === identity.userId || (!!identity.userName && actor.trim().toLowerCase() === identity.userName.toLowerCase()),
      ),
    );

    if (isOperator) {
      label = status === "needs_decision" ? "Needs your decision" : "Waiting on you";
    } else {
      // Name the first action taker we can show. The classifier returns platform IDs, but
      // sometimes a plain name; an ID we can't resolve isn't worth showing.
      const actorName = latestBlockEvent.actionRequiredFrom
        .map((id) => usableName(agentNameMap?.get(id), id) ?? usableName(id))
        .find((name): name is string => !!name);
      if (status === "needs_decision") {
        label = actorName ? `Needs ${actorName}'s decision` : "Needs someone else's decision";
      } else {
        label = actorName ? `Waiting on ${actorName}` : "Waiting on someone else";
      }
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
  events: Array<Event & { relation?: "primary" | "mentioned" }>,
  agentMap: Map<string, string>,
  agentAvatarMap: Map<string, string | null>,
  threadChannelMap: Map<string, { channelId: string; channelName: string }>,
  threadPlatformMap: Map<string, string>,
): TimelineEntry[] {
  // Events are expected to arrive in oldest-first order (chat style).
  // Preserve input order — do not re-sort.
  return events
    .filter((e) => e.entryType !== "noise")
    .map((e) => {
      const channel = threadChannelMap.get(e.threadId);
      return {
        id: e.id,
        entryType: e.entryType,
        status: e.status,
        timestamp: e.timestamp,
        agentId: e.agentId,
        agentName: e.agentId ? (agentMap.get(e.agentId) ?? null) : null,
        agentAvatarUrl: e.agentId ? (agentAvatarMap.get(e.agentId) ?? null) : null,
        channelId: channel?.channelId ?? "",
        channelName: channel?.channelName ?? "",
        threadId: e.threadId,
        platform: threadPlatformMap.get(e.threadId) ?? "",
        summary: e.reason,
        rawText: e.rawText,
        isOperator: e.agentId === null,
        relation: e.relation,
      };
    });
}
