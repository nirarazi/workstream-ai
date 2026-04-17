// core/types.ts — Shared types for the workstream.ai engine

export type StatusCategory =
  | "completed"
  | "in_progress"
  | "blocked_on_human"
  | "needs_decision"
  | "noise";

export type EntryType =
  | "block"
  | "decision"
  | "progress"
  | "assignment"
  | "escalation"
  | "noise";

export interface ClassificationBreakdown {
  workItemId: string;
  status: StatusCategory;
  entryType: EntryType;
  confidence: number;
  reason: string;
  title: string;
  targetedAtOperator: boolean;
}

export interface Classification {
  status: StatusCategory;
  entryType: EntryType;
  confidence: number;
  reason: string;
  workItemIds: string[];
  title: string;
  targetedAtOperator: boolean;
  /** Per-work-item statuses when a message is a summary/brief mentioning multiple items */
  breakdown?: ClassificationBreakdown[];
}

export interface Message {
  id: string;
  threadId: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  userAvatarUrl?: string;
  text: string;
  timestamp: string;
  platform: string;
}

export interface Thread {
  id: string;
  channelId: string;
  channelName: string;
  platformMeta?: Record<string, unknown>;
  platform: string;
  workItemId: string | null;
  lastActivity: string;
  messageCount: number;
  messages: Message[];
  manuallyLinked?: boolean;
}

export interface WorkItem {
  id: string;
  source: string;
  title: string;
  externalStatus: string | null;
  assignee: string | null;
  url: string | null;
  currentAtcStatus: StatusCategory | null;
  currentConfidence: number | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  platform: string;
  platformUserId: string;
  role: string | null;
  avatarUrl: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface Event {
  id: string;
  threadId: string;
  messageId: string;
  workItemId: string | null;
  agentId: string | null;
  status: StatusCategory;
  confidence: number;
  reason: string;
  rawText: string;
  timestamp: string;
  createdAt: string;
  entryType: EntryType;
  targetedAtOperator: boolean;
}

export interface Enrichment {
  id: string;
  workItemId: string;
  source: string;
  data: Record<string, unknown>;
  fetchedAt: string;
}

export interface PollCursor {
  channelId: string;
  lastTimestamp: string;
  updatedAt: string;
}

export interface Credentials {
  token: string;
  [key: string]: unknown;
}

export interface WorkItemDetail {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  url: string | null;
  labels: string[];
  description: string | null;
}

export interface WorkItemComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface ActionableItem {
  workItem: WorkItem;
  latestEvent: Event;
  agent: Agent | null;
  thread: Thread | null;
}
