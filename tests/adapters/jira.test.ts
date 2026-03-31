// tests/adapters/jira.test.ts — Tests for JiraAdapter

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraAdapter, JiraAuthError, JiraRateLimitError } from "../../core/adapters/tasks/jira/index.js";

// --- Mock fetch ---

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// --- Helpers ---

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeJiraIssue(overrides: Record<string, unknown> = {}) {
  return {
    key: "AI-382",
    self: "https://test.atlassian.net/rest/api/3/issue/AI-382",
    fields: {
      summary: "Implement auth flow",
      status: { name: "In Progress" },
      assignee: { displayName: "Byte" },
      labels: ["backend", "auth"],
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Build the OAuth authentication flow for the API." }],
          },
        ],
      },
    },
    ...overrides,
  };
}

const CREDENTIALS = {
  token: "dXNlckBleGFtcGxlLmNvbTphcGlfdG9rZW4=", // base64 user@example.com:api_token
  baseUrl: "https://test.atlassian.net",
};

// --- Tests ---

describe("JiraAdapter", () => {
  let adapter: JiraAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new JiraAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- connect --

  describe("connect", () => {
    it("should connect and verify credentials via /myself", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ displayName: "Operator" }),
      );

      await adapter.connect(CREDENTIALS);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/myself");
      expect(options.headers.Authorization).toBe(`Basic ${CREDENTIALS.token}`);
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers.Accept).toBe("application/json");
    });

    it("should throw on missing baseUrl", async () => {
      await expect(adapter.connect({ token: "abc" })).rejects.toThrow("baseUrl");
    });

    it("should throw on missing token", async () => {
      await expect(
        adapter.connect({ token: "", baseUrl: "https://x.atlassian.net" }),
      ).rejects.toThrow("token");
    });

    it("should throw JiraAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

      await expect(adapter.connect(CREDENTIALS)).rejects.toThrow(JiraAuthError);
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Server error" }, 500));

      await expect(adapter.connect(CREDENTIALS)).rejects.toThrow("verification failed");
    });

    it("should strip trailing slashes from baseUrl", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));

      await adapter.connect({ ...CREDENTIALS, baseUrl: "https://test.atlassian.net///" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/myself");
    });
  });

  // -- getWorkItem --

  describe("getWorkItem", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("should fetch and map a Jira issue to WorkItemDetail", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(makeJiraIssue()));

      const item = await adapter.getWorkItem("AI-382");

      expect(item).not.toBeNull();
      expect(item!.id).toBe("AI-382");
      expect(item!.title).toBe("Implement auth flow");
      expect(item!.status).toBe("In Progress");
      expect(item!.assignee).toBe("Byte");
      expect(item!.url).toBe("https://test.atlassian.net/rest/api/3/issue/AI-382");
      expect(item!.labels).toEqual(["backend", "auth"]);
      expect(item!.description).toBe("Build the OAuth authentication flow for the API.");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/AI-382");
      expect(url).toContain("fields=summary,status,assignee,labels,description");
    });

    it("should return null for 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errorMessages: ["not found"] }, 404));

      const item = await adapter.getWorkItem("NOPE-999");

      expect(item).toBeNull();
    });

    it("should handle issue with null assignee", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, assignee: null } })),
      );

      const item = await adapter.getWorkItem("AI-382");
      expect(item!.assignee).toBeNull();
    });

    it("should handle issue with null description", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, description: null } })),
      );

      const item = await adapter.getWorkItem("AI-382");
      expect(item!.description).toBeNull();
    });

    it("should truncate description longer than 200 chars", async () => {
      const longText = "A".repeat(300);
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          makeJiraIssue({
            fields: {
              ...makeJiraIssue().fields,
              description: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: longText }] }],
              },
            },
          }),
        ),
      );

      const item = await adapter.getWorkItem("AI-382");
      expect(item!.description).toHaveLength(200);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.getWorkItem("AI-1")).rejects.toThrow("not connected");
    });

    it("should throw JiraAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

      await expect(adapter.getWorkItem("AI-382")).rejects.toThrow(JiraAuthError);
    });

    it("should throw JiraRateLimitError on 429", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({}, 429, { "Retry-After": "30" }),
      );

      await expect(adapter.getWorkItem("AI-382")).rejects.toThrow(JiraRateLimitError);
    });

    it("should URL-encode issue IDs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(makeJiraIssue({ key: "AI-1" })));

      await adapter.getWorkItem("AI-1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/AI-1");
    });
  });

  // -- updateWorkItem --

  describe("updateWorkItem", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("should update title via PUT", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("AI-382", { title: "New title" });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/AI-382");
      expect(options.method).toBe("PUT");
      const body = JSON.parse(options.body);
      expect(body.fields.summary).toBe("New title");
    });

    it("should update labels via PUT", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("AI-382", { labels: ["urgent", "frontend"] });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.fields.labels).toEqual(["urgent", "frontend"]);
    });

    it("should transition status by finding matching transition", async () => {
      // GET transitions
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          transitions: [
            { id: "11", name: "To Do" },
            { id: "21", name: "In Progress" },
            { id: "31", name: "Done" },
          ],
        }),
      );
      // POST transition
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("AI-382", { status: "Done" });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify GET transitions
      const [transUrl] = mockFetch.mock.calls[0];
      expect(transUrl).toContain("/rest/api/3/issue/AI-382/transitions");

      // Verify POST transition
      const [postUrl, postOptions] = mockFetch.mock.calls[1];
      expect(postUrl).toContain("/rest/api/3/issue/AI-382/transitions");
      expect(postOptions.method).toBe("POST");
      const body = JSON.parse(postOptions.body);
      expect(body.transition.id).toBe("31");
    });

    it("should match transition name case-insensitively", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "31", name: "Done" }] }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("AI-382", { status: "done" });

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.transition.id).toBe("31");
    });

    it("should throw when no matching transition exists", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "11", name: "To Do" }] }),
      );

      await expect(
        adapter.updateWorkItem("AI-382", { status: "Cancelled" }),
      ).rejects.toThrow("No transition");
    });

    it("should handle both field updates and status transition", async () => {
      // PUT fields
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
      // GET transitions
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "31", name: "Done" }] }),
      );
      // POST transition
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("AI-382", { title: "Updated", status: "Done" });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.updateWorkItem("AI-1", { title: "x" })).rejects.toThrow("not connected");
    });
  });

  // -- searchWorkItems --

  describe("searchWorkItems", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("should search with JQL and return mapped results", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          issues: [makeJiraIssue(), makeJiraIssue({ key: "AI-383", fields: { ...makeJiraIssue().fields, summary: "Another task" } })],
          total: 2,
        }),
      );

      const results = await adapter.searchWorkItems("auth");

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("AI-382");
      expect(results[1].id).toBe("AI-383");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("jql=");
      expect(url).toContain("fields=summary%2Cstatus%2Cassignee%2Clabels%2Cdescription");
    });

    it("should escape double quotes in query", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ issues: [], total: 0 }));

      await adapter.searchWorkItems('test "value"');

      const [url] = mockFetch.mock.calls[0];
      // The query should have escaped quotes in the JQL
      expect(decodeURIComponent(url)).toContain('\\"value\\"');
    });

    it("should return empty array for no results", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ issues: [], total: 0 }));

      const results = await adapter.searchWorkItems("nonexistent");

      expect(results).toEqual([]);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.searchWorkItems("test")).rejects.toThrow("not connected");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Bad request" }, 400));

      await expect(adapter.searchWorkItems("test")).rejects.toThrow("search failed");
    });
  });

  // -- Error handling --

  describe("error handling", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("should parse Retry-After header on 429", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({}, 429, { "Retry-After": "45" }),
      );

      try {
        await adapter.getWorkItem("AI-1");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(JiraRateLimitError);
        expect((e as JiraRateLimitError).retryAfter).toBe(45);
      }
    });

    it("should default Retry-After to 60 when header is missing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 429));

      try {
        await adapter.getWorkItem("AI-1");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(JiraRateLimitError);
        expect((e as JiraRateLimitError).retryAfter).toBe(60);
      }
    });
  });

  // -- ADF description extraction --

  describe("ADF description extraction", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("should extract text from nested ADF content", async () => {
      const adf = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", text: "world" },
            ],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, description: adf } })),
      );

      const item = await adapter.getWorkItem("AI-382");
      expect(item!.description).toBe("Hello world");
    });

    it("should handle empty labels array", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, labels: [] } })),
      );

      const item = await adapter.getWorkItem("AI-382");
      expect(item!.labels).toEqual([]);
    });
  });
});
