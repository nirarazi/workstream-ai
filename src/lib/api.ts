/**
 * Typed fetch wrapper for the workstream.ai engine HTTP API.
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
  pinned: boolean;
  dismissedAt: string | null;
  dismissReason: "operator" | "expired" | null;
  /** Set when a later message brought a completed item back */
  reopenedAt?: string | null;
  /** When the current status was set (for a completed item, when it was finished) */
  statusAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StreamFilter = "needs-me" | "all-active" | "snoozed" | "done" | "dismissed";

export interface ActionResponse {
  ok: boolean;
  delivered: boolean;
}

export interface PinResponse {
  ok: boolean;
  pinned: boolean;
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
  llm?: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dailyBudget?: number | null;
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
  };
  rateLimits?: Record<string, number>;
  inbox?: { expireAfterDays: number | null };
}

export interface RateLimitInfo {
  maxPerMinute: number;
  displayName: string;
}

export interface SetupPrefill {
  messaging?: { adapter: string; fields: Record<string, string> };
  task?: { adapter: string; fields: Record<string, string> };
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dailyBudget?: number | null;
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
  };
  rateLimits?: Record<string, RateLimitInfo>;
  inbox?: { expireAfterDays: number | null };
}

export interface LlmBackoff {
  active: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  costSource: "api" | "configured" | null;
  dailyBudget: number | null;
  exhausted: boolean;
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
  llmUsage: LlmUsage | null;
  projectKeys?: string[];
  /** The engine serves the grouping lab (WORKSTREAM_LAB=true) */
  lab?: boolean;
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

  // In the desktop app, ask the Rust side for the engine's URL; fall back to the default. Its dev build goes through
  // the Vite dev server's proxy like a browser, as the engine trusts the dev server only through it.
  // (The Tauri package is bundled for the browser too, so importing it doesn't mean we're in the app.)
  if ("__TAURI_INTERNALS__" in window && !import.meta.env.DEV) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      resolvedBaseUrl = await invoke<string>("get_engine_url");
    } catch {
      resolvedBaseUrl = DEFAULT_ENGINE_URL;
    }
    return resolvedBaseUrl;
  }

  // In a browser: the page's own origin, the engine in web mode or the dev server's proxy in development
  // (WORKSTREAM_ENGINE_URL points the proxy elsewhere)
  resolvedBaseUrl = window.location.origin;
  return resolvedBaseUrl;
}

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

async function apiFetch<T>(path: string, options?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const base = await getBaseUrl();
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
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
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
): Promise<ActionResponse> {
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

export type EntryType = "block" | "decision" | "progress" | "assignment" | "escalation" | "noise";

export interface TimelineEntry {
  id: string;
  entryType: EntryType;
  status: string;
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
  hasOlder: boolean;
}

export async function fetchStream(
  workItemId: string,
  options?: { limit?: number; before?: string },
): Promise<StreamData> {
  let url = `/api/work-item/${encodeURIComponent(workItemId)}/stream`;
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return apiFetch(url);
}

export async function fetchAllActive(): Promise<{ items: ActionableItem[] }> {
  return apiFetch("/api/stream/all-active");
}

export async function fetchDismissed(): Promise<{ items: ActionableItem[] }> {
  return apiFetch("/api/stream/dismissed");
}

/** `total` counts every finished item (the list stops at 200); an older engine doesn't send it */
export async function fetchDone(): Promise<{ items: ActionableItem[]; total?: number }> {
  return apiFetch("/api/stream/done");
}

/** A digest's claim about a work item that the judge couldn't settle: the operator decides */
export interface DigestCheck {
  eventId: string;
  workItemId: string;
  title: string | null;
  appStatus: string | null;
  digestStatus: string;
  digestSaysNeedsYou: boolean;
  /** False when the digest had no line for this item: its status is the whole message's, and can't be taken */
  aboutThisItem: boolean;
  digestText: string;
  digestAt: string;
  sender: string | null;
  judgeNote: string | null;
}

export async function fetchDigestChecks(): Promise<{ items: DigestCheck[] }> {
  return apiFetch("/api/digest-checks");
}

export async function decideDigestCheck(eventId: string, workItemId: string, verdict: "app" | "digest"): Promise<{ ok: boolean }> {
  return apiFetch("/api/digest-checks/decide", {
    method: "POST",
    body: JSON.stringify({ eventId, workItemId, verdict }),
  });
}

export async function togglePin(workItemId: string): Promise<PinResponse> {
  return apiFetch(`/api/work-item/${encodeURIComponent(workItemId)}/pin`, {
    method: "POST",
    body: JSON.stringify({}),
  });
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

// A save can wait behind another save and then connect to Slack and Jira, which on a big workspace takes minutes
const SETUP_TIMEOUT_MS = 12 * 60 * 1000;

export function postSetup(config: SetupPayload): Promise<{ ok: boolean }> {
  return apiFetch("/api/setup", {
    method: "POST",
    body: JSON.stringify(config),
  }, SETUP_TIMEOUT_MS);
}

export function fetchSetupPrefill(): Promise<SetupPrefill> {
  return apiFetch("/api/setup/prefill");
}

export function fetchSetupAdapters(): Promise<SetupAdaptersResponse> {
  return apiFetch("/api/setup/adapters");
}

/**
 * Where the UI loads something the engine serves, given the path an API response named (avatars). Responses come
 * after the engine's address is known, so it's resolved by then.
 */
export function engineUrl(path: string): string {
  return path.startsWith("/api/") ? `${resolvedBaseUrl ?? ""}${path}` : path;
}

// ---------------------------------------------------------------------------
// Badge — sets the dock badge count (macOS) via Tauri command
// ---------------------------------------------------------------------------

export async function setBadgeCount(count: number): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_badge_count", { count });
  } catch {
    // Command unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// External URL opener — uses Tauri shell plugin in WebView, falls back to
// window.open in browser. Only web and email links open (see openableUrl).
// ---------------------------------------------------------------------------

/** Schemes that may open. Keep in step with plugins.shell.open in src-tauri/tauri.conf.json */
const OPENABLE_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * The link as it will open, or null if it may not: links can come from message content, so only web and email
 * links open, never local files or other apps' handlers. The parsed form, so what's checked is what opens.
 */
export function openableUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!OPENABLE_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol === "mailto:") {
      // Just the address: query fields (attachments, in some mail clients) are the sender's to choose, not a message's
      parsed.search = "";
      // An empty address has nothing to open, and the desktop app's check refuses it
      if (!parsed.pathname) return null;
    }
    // Email links keep spaces unencoded; the desktop app's check refuses any
    return /\s/.test(parsed.href) ? null : parsed.href;
  } catch {
    return null;
  }
}

export async function openExternalUrl(raw: string): Promise<void> {
  const url = openableUrl(raw);
  if (!url) {
    console.warn("Not opening a link that isn't a web or email link");
    return;
  }
  // In the desktop app, the shell's refusal is final; the browser fallback is for the web UI
  if ("__TAURI_INTERNALS__" in window) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url).catch((err: unknown) => console.warn("Couldn't open the link", err));
    return;
  }
  window.open(url, "_blank", "noreferrer");
}

// ---------------------------------------------------------------------------
// Work item merge operations
// ---------------------------------------------------------------------------

export interface MergeRecord {
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  movedThreadIds: string[];
}

export function mergeWorkItems(
  targetId: string,
  sourceId: string,
): Promise<{ ok: boolean; record: MergeRecord }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(targetId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

export function unmergeWorkItem(sourceId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/work-item/${encodeURIComponent(sourceId)}/unmerge`, {
    method: "POST",
  });
}

export function searchWorkItems(
  query: string,
): Promise<{ items: Array<{ id: string; title: string; currentAtcStatus: string | null }> }> {
  return apiFetch(`/api/work-items/search?q=${encodeURIComponent(query)}`);
}

// ---------------------------------------------------------------------------
// Grouping lab (only when the engine runs with WORKSTREAM_LAB=true)
// ---------------------------------------------------------------------------

export interface LabStream {
  key: string;
  /** A channel stream's name ("#ops"); others are their key */
  label: string;
  caseCount: number;
  messages: number;
  last: string;
}

export interface LabCaseSummary {
  id: string;
  keys: string[];
  size: number;
  first: string;
  last: string;
  title: string;
}

export interface LabNode {
  key: string;
  sender: string;
  senderKind: string;
  channel: string;
  at: string;
  threadId: string;
  topLevel: boolean;
  text: string;
  about: string | null;
  reasons: string[];
}

export interface LabEdge {
  from: string;
  to: string;
  reason: string;
}

export interface LabCase {
  case: { id: string; keys: string[]; stream: string; streamLabel: string };
  nodes: LabNode[];
  edges: LabEdge[];
}

export function fetchLabStreams(q?: string): Promise<{ streams: LabStream[]; total: number }> {
  return apiFetch(`/api/lab/streams${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

export function fetchLabStream(key: string): Promise<{ stream: LabStream; cases: LabCaseSummary[] }> {
  return apiFetch(`/api/lab/stream?key=${encodeURIComponent(key)}`);
}

export function fetchLabCase(id: string): Promise<LabCase> {
  return apiFetch(`/api/lab/case/${encodeURIComponent(id)}`);
}
