/**
 * Typed fetch wrapper for the ATC engine HTTP API.
 * Detects Tauri vs browser environment and resolves the engine URL accordingly.
 * This is the only file that imports @tauri-apps/api.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkItem {
  id: string;
  source: string;
  title: string;
  externalStatus: string | null;
  assignee: string | null;
  url: string | null;
  currentAtcStatus: string | null;
  currentConfidence: number | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LatestEvent {
  id: string;
  threadId: string;
  messageId: string;
  workItemId: string | null;
  agentId: string | null;
  status: string;
  confidence: number;
  reason: string;
  rawText: string;
  timestamp: string;
  createdAt: string;
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

/** A user/agent that can be @mentioned in a reply */
export interface Mentionable {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

/** Convert agents to mentionables for the typeahead */
export function agentsToMentionables(agents: Agent[]): Mentionable[] {
  return agents
    .filter((a) => a.platformUserId && a.name !== a.platformUserId)
    .map((a) => ({ id: a.platformUserId, name: a.name, avatarUrl: a.avatarUrl }));
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
  manuallyLinked?: boolean;
}

export interface ActionableItem {
  workItem: WorkItem;
  latestEvent: LatestEvent;
  agent: Agent | null;
  thread: Thread | null;
}

export interface SetupField {
  key: string;
  label: string;
  type: "text" | "password" | "email" | "url";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  helpUrl?: string;
}

export interface AdapterSetupInfo {
  name: string;
  displayName: string;
  fields: SetupField[];
  helpUrl?: string;
}

export interface SetupAdaptersResponse {
  messaging: AdapterSetupInfo[];
  task: AdapterSetupInfo[];
}

export interface SetupStatus {
  configured: boolean;
  llm: boolean;
  adapters: {
    messaging: { name: string; connected: boolean } | null;
    task: { name: string; connected: boolean } | null;
  };
  platformMeta: Record<string, unknown>;
}

export interface SetupPayload {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm?: { apiKey: string; baseUrl: string; model: string };
  rateLimits?: Record<string, number>;
}

export interface RateLimitInfo {
  maxPerMinute: number;
  displayName: string;
}

export interface SetupPrefill {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm: { apiKey: string; baseUrl: string; model: string };
  rateLimits?: Record<string, RateLimitInfo>;
}

export interface LlmBackoff {
  active: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
}

export type ServiceStatus = "ok" | "degraded" | "disconnected";

/** Dynamic map of service name → status. Keys come from the server based on which adapters are loaded. */
export type ServiceStatuses = Record<string, ServiceStatus>;

export interface EngineStatus {
  ok: boolean;
  uptime: number;
  pipeline: unknown;
  services: ServiceStatuses;
  llmBackoff: LlmBackoff | null;
}

export interface WorkItemDetail {
  workItem: WorkItem;
  threads: Thread[];
  events: LatestEvent[];
}

export interface WorkItemComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface Enrichment {
  id: string;
  workItemId: string;
  source: string;
  data: Record<string, unknown>;
  fetchedAt: string;
}

export interface WorkItemContext {
  workItem: WorkItem;
  threads: Thread[];
  events: LatestEvent[];
  enrichments: Enrichment[];
  quickReplies: string[];
  summary: string | null;
}

// ---------------------------------------------------------------------------
// Engine URL resolution
// ---------------------------------------------------------------------------

const DEFAULT_ENGINE_URL = "http://127.0.0.1:9847";

let resolvedBaseUrl: string | null = null;

async function getBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) return resolvedBaseUrl;

  // Try Tauri environment first
  try {
    const tauri = await import("@tauri-apps/api/core");
    // If the import succeeds we're inside a Tauri WebView.
    // Try to get a configured URL from the Rust side; fall back to default.
    try {
      const url = await (tauri as { invoke: (cmd: string) => Promise<string> }).invoke("get_engine_url");
      resolvedBaseUrl = url;
    } catch {
      resolvedBaseUrl = DEFAULT_ENGINE_URL;
    }
    return resolvedBaseUrl;
  } catch {
    // Not in Tauri — use Vite env or origin
  }

  const envUrl = import.meta.env.VITE_ENGINE_URL as string | undefined;
  resolvedBaseUrl = envUrl || window.location.origin;
  return resolvedBaseUrl;
}

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const base = await getBaseUrl();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed API functions
// ---------------------------------------------------------------------------

export function fetchInbox(): Promise<{ items: ActionableItem[] }> {
  return apiFetch("/api/inbox");
}

export function fetchRecent(limit = 20): Promise<{ items: ActionableItem[] }> {
  return apiFetch(`/api/recent?limit=${limit}`);
}

export function fetchWorkItem(id: string): Promise<WorkItemDetail> {
  return apiFetch(`/api/work-item/${encodeURIComponent(id)}`);
}

export function fetchAgents(): Promise<{ agents: Agent[] }> {
  return apiFetch("/api/agents");
}

export function fetchStatus(): Promise<EngineStatus> {
  return apiFetch("/api/status");
}

export function fetchSetupStatus(): Promise<SetupStatus> {
  return apiFetch("/api/setup/status");
}

export function postReply(
  threadId: string | undefined,
  channelId: string | undefined,
  message: string,
  options?: { targetUserId?: string; workItemId?: string },
): Promise<{ ok: boolean; threadId?: string; channelId?: string }> {
  return apiFetch("/api/reply", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      channelId,
      message,
      targetUserId: options?.targetUserId,
      workItemId: options?.workItemId,
    }),
  });
}

export function postAction(
  workItemId: string,
  action: string,
  message?: string,
  snoozeDuration?: number,
): Promise<{ ok: boolean }> {
  return apiFetch("/api/action", {
    method: "POST",
    body: JSON.stringify({ workItemId, action, message, snoozeDuration }),
  });
}

export function createTicket(
  workItemId: string,
  projectKey?: string,
): Promise<{ ok: boolean; ticketId?: string; ticketUrl?: string }> {
  return apiFetch("/api/action", {
    method: "POST",
    body: JSON.stringify({ workItemId, action: "create_ticket", projectKey }),
  });
}

export function fetchWorkItemContext(id: string): Promise<WorkItemContext> {
  return apiFetch(`/api/work-item/${encodeURIComponent(id)}/context`);
}

export function generateSummary(id: string): Promise<{ summary: string }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(id)}/summarize`, {
    method: "POST",
  });
}

export interface AnomalyFlag {
  type: "stale" | "silent_agent" | "status_regression" | "duplicate_work";
  message: string;
}

export interface FleetItem extends ActionableItem {
  anomalies: AnomalyFlag[];
}

export function fetchFleet(): Promise<{ items: FleetItem[] }> {
  return apiFetch("/api/fleet");
}

export interface SidekickMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SidekickResult {
  answer: string;
  sources: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
}

export function askSidekick(
  question: string,
  history: SidekickMessage[],
): Promise<SidekickResult> {
  return apiFetch("/api/sidekick", {
    method: "POST",
    body: JSON.stringify({ question, history }),
  });
}

export function linkThread(
  workItemId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/link-thread`, {
    method: "POST",
    body: JSON.stringify({ threadId }),
  });
}

export function unlinkThread(
  workItemId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/unlink-thread`, {
    method: "POST",
    body: JSON.stringify({ threadId }),
  });
}

export function fetchUnlinkedThreads(
  limit = 20,
  query?: string,
): Promise<{ threads: Thread[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("q", query);
  return apiFetch(`/api/threads/unlinked?${params}`);
}

export function linkThreadByUrl(
  workItemId: string,
  url: string,
): Promise<{ ok: boolean; threadId: string }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/link-url`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function postForward(params: {
  sourceThreadId: string;
  sourceChannelId: string;
  targetId: string;
  targetType: "user" | "channel";
  quoteMode?: "latest" | "full";
  includeSummary?: boolean;
  note?: string;
}): Promise<{ ok: boolean; threadId: string; channelId: string }> {
  return apiFetch("/api/forward", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function postSetup(config: SetupPayload): Promise<{ ok: boolean }> {
  return apiFetch("/api/setup", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function fetchSetupPrefill(): Promise<SetupPrefill> {
  return apiFetch("/api/setup/prefill");
}

export function fetchSetupAdapters(): Promise<SetupAdaptersResponse> {
  return apiFetch("/api/setup/adapters");
}

// ---------------------------------------------------------------------------
// Badge — sets the dock badge count (macOS) via Tauri command
// ---------------------------------------------------------------------------

export async function setBadgeCount(count: number): Promise<void> {
  try {
    const tauri = await import("@tauri-apps/api/core");
    await (tauri as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<void> }).invoke("set_badge_count", { count });
  } catch {
    // Not in Tauri or command unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// External URL opener — uses Tauri shell plugin in WebView, falls back to
// window.open in browser.
// ---------------------------------------------------------------------------

export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank", "noreferrer");
  }
}
