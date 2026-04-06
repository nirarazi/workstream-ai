// core/adapters/tasks/jira/index.ts — Jira REST API v3 adapter

import type { Credentials, WorkItemDetail, WorkItemComment } from "../../../types.js";
import type { TaskAdapter } from "../interface.js";
import type { AdapterSetupInfo } from "../../setup.js";
import { createLogger } from "../../../logger.js";
import { registerTaskAdapter } from "../../registry.js";
import type { RateLimiter } from "../../../rate-limiter.js";

const log = createLogger("jira-adapter");

// --- Jira API response types ---

interface JiraIssueFields {
  summary: string;
  status: { name: string };
  assignee: { displayName: string } | null;
  labels: string[];
  description: unknown; // ADF document or null
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
  };
}

const ISSUE_FIELDS = "summary,status,assignee,labels,description";

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
          envVar: "ATC_JIRA_EMAIL",
        },
        {
          key: "token",
          label: "API Token",
          type: "password",
          required: true,
          placeholder: "Jira API token",
          envVar: "ATC_JIRA_API_TOKEN",
        },
        {
          key: "baseUrl",
          label: "Base URL",
          type: "url",
          required: true,
          placeholder: "https://your-org.atlassian.net",
          envVar: "ATC_JIRA_BASE_URL",
        },
      ],
    };
  }

  prepareCredentials(fields: Record<string, string>): Record<string, string> {
    const authToken = Buffer.from(`${fields.email}:${fields.token}`).toString("base64");
    return {
      token: authToken,
      baseUrl: fields.baseUrl,
    };
  }

  private baseUrl = "";
  private authToken = "";
  private connected = false;
  private rateLimiter?: RateLimiter;

  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
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

  async connect(credentials: Credentials): Promise<void> {
    const baseUrl = credentials.baseUrl as string | undefined;
    if (!baseUrl || typeof baseUrl !== "string") {
      throw new Error("Jira credentials must include baseUrl");
    }
    if (!credentials.token) {
      throw new Error("Jira credentials must include token (base64 email:api_token)");
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = credentials.token;

    log.info("Verifying Jira connection...", this.baseUrl);

    const response = await this.request("/rest/api/3/myself");
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira connection verification failed (${response.status}): ${text}`);
    }

    const user = (await response.json()) as { displayName: string };
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
