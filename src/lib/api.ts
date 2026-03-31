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
  firstSeen: string;
  lastSeen: string;
}

export interface Thread {
  id: string;
  channelId: string;
  channelName: string;
  platform: string;
  workItemId: string | null;
  lastActivity: string;
  messageCount: number;
}

export interface ActionableItem {
  workItem: WorkItem;
  latestEvent: LatestEvent;
  agent: Agent | null;
  thread: Thread | null;
}

export interface SetupStatus {
  configured: boolean;
  slack: boolean;
  llm: boolean;
  jira: boolean;
}

export interface SetupConfig {
  slackToken: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  jiraToken?: string;
  jiraBaseUrl?: string;
}

export interface EngineStatus {
  ok: boolean;
  uptime: number;
  pipeline: unknown;
}

export interface WorkItemDetail {
  workItem: WorkItem;
  threads: Thread[];
  events: LatestEvent[];
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
  threadId: string,
  channelId: string,
  message: string,
): Promise<{ ok: boolean }> {
  return apiFetch("/api/reply", {
    method: "POST",
    body: JSON.stringify({ threadId, channelId, message }),
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

export function postSetup(config: SetupConfig): Promise<{ ok: boolean }> {
  return apiFetch("/api/setup", {
    method: "POST",
    body: JSON.stringify(config),
  });
}
