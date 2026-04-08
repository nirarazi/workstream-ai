// tests/adapters/jira-url.test.ts — Tests for Jira mapIssueToWorkItem URL generation

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "../../core/adapters/tasks/jira/index.js";

// We need to test mapIssueToWorkItem indirectly through the adapter's
// getWorkItem method, since mapIssueToWorkItem is not exported.
// Mock fetch to control Jira API responses.

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress logger output
vi.mock("../../core/logger.js", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

function makeJiraIssue(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    self: `https://jira.example.com/rest/api/3/issue/${key}`,
    fields: {
      summary: `Test issue ${key}`,
      status: { name: "In Progress" },
      assignee: { displayName: "Agent Byte" },
      labels: ["backend"],
      description: null,
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Jira adapter — work item URL generation", () => {
  let adapter: JiraAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new JiraAdapter();

    // Mock the connect verification call
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ displayName: "Operator" }),
    );

    await adapter.connect({
      baseUrl: "https://jira.example.com",
      token: "dGVzdDp0b2tlbg==", // base64 test:token
    });
  });

  it("produces browse URL, not REST API URL", async () => {
    const issue = makeJiraIssue("AI-382");
    mockFetch.mockResolvedValueOnce(jsonResponse(issue));

    const item = await adapter.getWorkItem("AI-382");

    expect(item).not.toBeNull();
    expect(item!.url).toBe("https://jira.example.com/browse/AI-382");
    // Confirm it does NOT use the REST self link
    expect(item!.url).not.toContain("/rest/api/");
  });

  it("works with different base URLs", async () => {
    // Create a new adapter with a different baseUrl
    const adapter2 = new JiraAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ displayName: "Operator" }),
    );
    await adapter2.connect({
      baseUrl: "https://mycompany.atlassian.net",
      token: "dGVzdDp0b2tlbg==",
    });

    const issue = makeJiraIssue("IT-100");
    mockFetch.mockResolvedValueOnce(jsonResponse(issue));

    const item = await adapter2.getWorkItem("IT-100");

    expect(item).not.toBeNull();
    expect(item!.url).toBe("https://mycompany.atlassian.net/browse/IT-100");
  });

  it("strips trailing slash from baseUrl in the browse URL", async () => {
    const adapter3 = new JiraAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ displayName: "Operator" }),
    );
    await adapter3.connect({
      baseUrl: "https://jira.example.com/",
      token: "dGVzdDp0b2tlbg==",
    });

    const issue = makeJiraIssue("MS-50");
    mockFetch.mockResolvedValueOnce(jsonResponse(issue));

    const item = await adapter3.getWorkItem("MS-50");

    expect(item).not.toBeNull();
    // The adapter strips trailing slashes during connect(), so URL is clean
    expect(item!.url).toBe("https://jira.example.com/browse/MS-50");
  });

  it("maps all core fields correctly alongside the URL", async () => {
    const issue = makeJiraIssue("AI-500", {
      summary: "Implement feature X",
      status: { name: "Done" },
      assignee: { displayName: "Byte" },
      labels: ["frontend", "urgent"],
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(issue));

    const item = await adapter.getWorkItem("AI-500");

    expect(item).not.toBeNull();
    expect(item!.id).toBe("AI-500");
    expect(item!.title).toBe("Implement feature X");
    expect(item!.status).toBe("Done");
    expect(item!.assignee).toBe("Byte");
    expect(item!.labels).toEqual(["frontend", "urgent"]);
    expect(item!.url).toBe("https://jira.example.com/browse/AI-500");
  });

  it("returns null for 404 responses", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    const item = await adapter.getWorkItem("NONEXIST-1");
    expect(item).toBeNull();
  });
});
