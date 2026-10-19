// core/adapters/tasks/jira/index.ts — Jira REST API v3 adapter

import type { Credentials, WorkItemDetail, WorkItemComment } from "../../../types.js";
import type { TaskAdapter } from "../interface.js";
import type { AdapterSetupInfo } from "../../setup.js";
import { createLogger } from "../../../logger.js";
import { registerTaskAdapter } from "../../registry.js";
import type { RateLimiter } from "../../../rate-limiter.js";

const log = createLogger("jira-adapter");

/** How long a fetched project list is used before it's fetched again, and the wait after a failed fetch */
const PROJECT_KEYS_TTL_MS = 60 * 60 * 1000;
const PROJECT_KEYS_RETRY_MS = 5 * 60 * 1000;
/** Pages of 50 projects read at most. A site with more isn't used as a prefix list: a partial list would reject real tickets. */
const MAX_PROJECT_PAGES = 20;
/** Jira project keys: a letter, then letters, digits or underscores (10 characters by default; capped here so a key can't bloat the prompt) */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/i;

/** Plain http is allowed only to these: names like foo.localhost aren't resolved to this machine everywhere */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The base URL the API token is sent to. It must be https, since the token goes in every request's
 * Authorization header; plain http is allowed only to this machine (a local Jira or a test server).
 */
export function checkJiraBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Jira base URL isn't a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("Jira base URL must start with https:// (http:// only for localhost)");
  }
  if (url.username || url.password) throw new Error("Jira base URL must not contain a user name or password");
  if (url.search || url.hash) throw new Error("Jira base URL must not contain a query or fragment");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// --- Jira API response types ---

interface JiraIssueFields {
  summary: string;
  status: { name: string };
  assignee: { displayName: string } | null;
  labels: string[];
  description: unknown; // ADF document or null
  issuetype?: { id: string; name: string; hierarchyLevel?: number };
  parent?: { key: string; fields?: { summary?: string } };
  issuelinks?: Array<{ type?: { name?: string; outward?: string }; outwardIssue?: { key: string } }>;
}

interface JiraIssue {
  key: string;
  self: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

interface JiraTransition {
  id: string;
  name: string;
}

interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

// --- Error classes ---

export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraAuthError";
  }
}

export class JiraNotFoundError extends Error {
  constructor(id: string) {
    super(`Jira issue not found: ${id}`);
    this.name = "JiraNotFoundError";
  }
}

export class JiraRateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`Jira rate limit exceeded, retry after ${retryAfter}s`);
    this.name = "JiraRateLimitError";
    this.retryAfter = retryAfter;
  }
}

// --- Helpers ---

function extractPlainText(adfNode: unknown): string {
  if (adfNode === null || adfNode === undefined) return "";
  if (typeof adfNode === "string") return adfNode;
  if (typeof adfNode !== "object") return "";

  const node = adfNode as Record<string, unknown>;

  // ADF text node
  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }

  // Recurse into content array
  if (Array.isArray(node.content)) {
    const parts: string[] = [];
    for (const child of node.content) {
      parts.push(extractPlainText(child));
    }
    return parts.join("");
  }

  return "";
}

function mapIssueToWorkItem(issue: JiraIssue, baseUrl: string): WorkItemDetail {
  const rawDescription = extractPlainText(issue.fields.description);
  const description = rawDescription.length > 200
    ? rawDescription.slice(0, 200)
    : rawDescription || null;

  return {
    id: issue.key,
    title: issue.fields.summary,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? null,
    url: `${baseUrl}/browse/${issue.key}`,
    labels: issue.fields.labels ?? [],
    description,
    ...(issue.fields.issuetype
      ? { itemType: { id: issue.fields.issuetype.id, name: issue.fields.issuetype.name, hierarchyLevel: issue.fields.issuetype.hierarchyLevel ?? null } }
      : {}),
    ...(issue.fields.parent ? { parent: { key: issue.fields.parent.key, title: issue.fields.parent.fields?.summary } } : {}),
    ...duplicatesOf(issue),
  };
}

/** The issues this one duplicates: its outward links of Jira's "Duplicate" type (named so by default, or "duplicates") */
function duplicatesOf(issue: JiraIssue): { duplicates?: string[] } {
  const keys = (issue.fields.issuelinks ?? [])
    .filter((l) => l.outwardIssue && /duplicate/i.test(`${l.type?.name ?? ""} ${l.type?.outward ?? ""}`))
    .map((l) => l.outwardIssue!.key);
  return keys.length > 0 ? { duplicates: keys } : {};
}

const ISSUE_FIELDS = "summary,status,assignee,labels,description,issuetype,parent,issuelinks";

// --- Adapter ---

export class JiraAdapter implements TaskAdapter {
  name = "jira";
  displayName = "Jira";

  getSetupInfo(): AdapterSetupInfo {
    return {
      name: "jira",
      displayName: "Jira",
      helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
      fields: [
        {
          key: "email",
          label: "Email",
          type: "email",
          required: true,
          placeholder: "you@company.com",
          envVar: "WORKSTREAM_JIRA_EMAIL",
        },
        {
          key: "token",
          label: "API Token",
          type: "password",
          required: true,
          placeholder: "Jira API token",
          envVar: "WORKSTREAM_JIRA_API_TOKEN",
        },
        {
          key: "baseUrl",
          label: "Base URL",
          type: "url",
          required: true,
          placeholder: "https://your-org.atlassian.net",
          envVar: "WORKSTREAM_JIRA_BASE_URL",
        },
      ],
    };
  }

  /** Throws when the base URL isn't safe to send the token to, so Settings can refuse it before saving */
  prepareCredentials(fields: Record<string, string>): Record<string, string> {
    const authToken = Buffer.from(`${fields.email}:${fields.token}`).toString("base64");
    return {
      token: authToken,
      baseUrl: checkJiraBaseUrl(fields.baseUrl ?? ""),
    };
  }

  private baseUrl = "";
  private authToken = "";
  private connected = false;
  private rateLimiter?: RateLimiter;
  private authedUser: { userId: string; userName: string } | null = null;
  private projectPrefixes: string[] = [];
  private projectKeysDueAt = 0;
  private projectKeysLoading: Promise<void> | null = null;
  /** Bumped on every connect, so a project list fetched for an earlier connection is dropped */
  private connection = 0;

  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  getAuthenticatedUser(): { userId: string; userName: string } | null {
    return this.authedUser;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Basic ${this.authToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    if (this.rateLimiter) {
      await this.rateLimiter.acquire();
    }
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...(options.headers as Record<string, string> ?? {}) },
    });

    if (response.status === 401) {
      throw new JiraAuthError("Invalid Jira credentials");
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
      throw new JiraRateLimitError(retryAfter);
    }

    return response;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("Jira adapter not connected — call connect() first");
    }
  }

  async connect(credentials: Credentials, signal?: AbortSignal): Promise<void> {
    this.connected = false; // until these credentials are verified
    const baseUrl = credentials.baseUrl as string | undefined;
    if (!baseUrl || typeof baseUrl !== "string") {
      throw new Error("Jira credentials must include baseUrl");
    }
    if (!credentials.token) {
      throw new Error("Jira credentials must include token (base64 email:api_token)");
    }

    this.baseUrl = checkJiraBaseUrl(baseUrl);
    this.projectPrefixes = [];
    this.projectKeysDueAt = 0;
    this.projectKeysLoading = null;
    this.connection++;
    this.authToken = credentials.token;

    log.info("Verifying Jira connection...", this.baseUrl);

    const response = await this.request("/rest/api/3/myself", { signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira connection verification failed (${response.status}): ${text}`);
    }

    const user = (await response.json()) as { displayName: string; emailAddress?: string; accountId?: string };
    this.authedUser = {
      userId: user.accountId ?? user.emailAddress ?? "",
      userName: user.displayName,
    };
    log.info("Connected to Jira as", user.displayName);
    this.connected = true;
  }

  async getWorkItem(id: string): Promise<WorkItemDetail | null> {
    this.ensureConnected();

    const response = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${ISSUE_FIELDS}`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get Jira issue ${id} (${response.status}): ${text}`);
    }

    const issue = (await response.json()) as JiraIssue;
    return mapIssueToWorkItem(issue, this.baseUrl);
  }

  async updateWorkItem(id: string, update: Partial<WorkItemDetail>): Promise<void> {
    this.ensureConnected();

    // Handle field updates (title, description, labels, assignee)
    const fields: Record<string, unknown> = {};
    if (update.title !== undefined) fields.summary = update.title;
    if (update.description !== undefined) {
      fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: update.description }],
          },
        ],
      };
    }
    if (update.labels !== undefined) fields.labels = update.labels;

    if (Object.keys(fields).length > 0) {
      const response = await this.request(
        `/rest/api/3/issue/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ fields }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to update Jira issue ${id} (${response.status}): ${text}`);
      }
    }

    // Handle status transitions separately
    if (update.status !== undefined) {
      await this.transitionIssue(id, update.status);
    }
  }

  private async transitionIssue(id: string, targetStatus: string): Promise<void> {
    // Get available transitions
    const transResponse = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    );

    if (!transResponse.ok) {
      const text = await transResponse.text();
      throw new Error(`Failed to get transitions for ${id} (${transResponse.status}): ${text}`);
    }

    const { transitions } = (await transResponse.json()) as JiraTransitionsResponse;
    const match = transitions.find(
      (t) => t.name.toLowerCase() === targetStatus.toLowerCase(),
    );

    if (!match) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(
        `No transition to "${targetStatus}" for ${id}. Available: ${available}`,
      );
    }

    const response = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
      {
        method: "POST",
        body: JSON.stringify({ transition: { id: match.id } }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to transition ${id} to "${targetStatus}" (${response.status}): ${text}`);
    }

    log.info(`Transitioned ${id} to "${targetStatus}"`);
  }

  /**
   * The site's project keys as ticket prefixes ("OPS-"). Answers from the last fetched list and,
   * when that is due, fetches it again in the background, so a call before the first fetch lands
   * returns an empty list (callers then fall back to configured prefixes). Only projects the
   * token's user can browse are listed.
   */
  getValidIdPrefixes(): string[] {
    if (this.connected && !this.projectKeysLoading && Date.now() >= this.projectKeysDueAt) {
      const connection = this.connection;
      const current = () => connection === this.connection; // not replaced by a newer connect meanwhile
      this.projectKeysLoading = this.fetchProjectKeys()
        .then((keys) => {
          if (!current()) return;
          this.projectPrefixes = keys.map((key) => `${key.toUpperCase()}-`);
          this.projectKeysDueAt = Date.now() + PROJECT_KEYS_TTL_MS;
          log.info(`Loaded ${keys.length} Jira project keys`);
        })
        .catch((err) => {
          if (!current()) return;
          this.projectKeysDueAt = Date.now() + PROJECT_KEYS_RETRY_MS;
          log.warn(`Couldn't list Jira projects: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          if (current()) this.projectKeysLoading = null;
        });
    }
    return [...this.projectPrefixes];
  }

  /** Every project key on the site; an empty list when there are too many to read (see MAX_PROJECT_PAGES) */
  private async fetchProjectKeys(): Promise<string[]> {
    const keys: string[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: "50" });
      const response = await this.request(`/rest/api/3/project/search?${params.toString()}`);
      if (!response.ok) throw new Error(`project search failed (${response.status})`);
      const data = (await response.json()) as { values?: Array<{ key?: unknown }>; isLast?: boolean };
      const values = data.values ?? [];
      for (const project of values) {
        if (typeof project.key === "string" && PROJECT_KEY.test(project.key)) keys.push(project.key);
      }
      if (data.isLast !== false || values.length === 0) return keys;
      startAt += values.length;
    }
    log.warn(`Jira has more than ${MAX_PROJECT_PAGES * 50} projects: not using them as ticket prefixes`);
    return [];
  }

  async searchWorkItems(query: string): Promise<WorkItemDetail[]> {
    this.ensureConnected();

    const escapedQuery = query.replace(/"/g, '\\"');
    const jql = `summary ~ "${escapedQuery}" OR key = "${escapedQuery}"`;
    const params = new URLSearchParams({
      jql,
      fields: ISSUE_FIELDS,
      maxResults: "50",
    });

    const response = await this.request(`/rest/api/3/search?${params.toString()}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira search failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as JiraSearchResponse;
    return data.issues.map((issue) => mapIssueToWorkItem(issue, this.baseUrl));
  }

  async createWorkItem(params: import("../interface.js").CreateWorkItemParams): Promise<WorkItemDetail> {
    this.ensureConnected();

    const fields: Record<string, unknown> = {
      project: { key: params.projectKey },
      summary: params.title,
      issuetype: { name: params.issueType ?? "Task" },
    };

    if (params.description) {
      fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: params.description }],
          },
        ],
      };
    }

    const response = await this.request("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create Jira issue (${response.status}): ${text}`);
    }

    const created = (await response.json()) as { key: string };
    log.info("Created Jira issue", created.key);

    // Fetch the full issue to return consistent WorkItemDetail
    const detail = await this.getWorkItem(created.key);
    return detail!;
  }

  async getComments(id: string): Promise<WorkItemComment[]> {
    this.ensureConnected();

    const response = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(id)}/comment?orderBy=created&maxResults=5`,
    );

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get comments for ${id} (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      comments: Array<{
        id: string;
        author: { displayName: string };
        body: unknown;
        created: string;
      }>;
    };

    return data.comments.map((c) => ({
      id: c.id,
      author: c.author.displayName,
      body: extractPlainText(c.body),
      created: c.created,
    }));
  }
}

// Self-register with the adapter registry
registerTaskAdapter("jira", () => new JiraAdapter());
