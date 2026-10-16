// tests/adapters/jira.test.ts — Tests for JiraAdapter

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraAdapter, JiraAuthError, JiraRateLimitError, checkJiraBaseUrl } from "../../core/adapters/tasks/jira/index.js";

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
    key: "OPS-382",
    self: "https://test.atlassian.net/rest/api/3/issue/OPS-382",
    fields: {
      summary: "Implement auth flow",
      status: { name: "In Progress" },
      assignee: { displayName: "Relay" },
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

  // -- base URL --

  describe("base URL", () => {
    it("accepts https, keeps a context path, and drops trailing slashes", () => {
      expect(checkJiraBaseUrl("https://test.atlassian.net/")).toBe("https://test.atlassian.net");
      expect(checkJiraBaseUrl(" https://jira.example.com/jira// ")).toBe("https://jira.example.com/jira");
    });

    it("allows plain http only to this machine", () => {
      expect(checkJiraBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
      expect(checkJiraBaseUrl("http://127.0.0.1:8080/jira")).toBe("http://127.0.0.1:8080/jira");
      // Not every resolver sends *.localhost to this machine
      expect(() => checkJiraBaseUrl("http://jira.localhost:8080")).toThrow(/https/);
      expect(() => checkJiraBaseUrl("http://jira.example.com")).toThrow(/https/);
      expect(() => checkJiraBaseUrl("http://localhost.example.com")).toThrow(/https/);
      expect(() => checkJiraBaseUrl("ftp://jira.example.com")).toThrow(/https/);
    });

    it("refuses credentials, queries, fragments and things that aren't URLs", () => {
      expect(() => checkJiraBaseUrl("https://user:pw@jira.example.com")).toThrow(/user name or password/);
      expect(() => checkJiraBaseUrl("https://jira.example.com/?x=1")).toThrow(/query/);
      expect(() => checkJiraBaseUrl("https://jira.example.com/#top")).toThrow(/fragment/);
      expect(() => checkJiraBaseUrl("jira.example.com")).toThrow(/valid URL/);
    });

    it("never sends the token to an http base URL", async () => {
      await expect(adapter.connect({ ...CREDENTIALS, baseUrl: "http://jira.example.com" })).rejects.toThrow(/https/);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(() => adapter.prepareCredentials({ email: "dana@example.com", token: "t", baseUrl: "http://jira.example.com" })).toThrow(/https/);
    });
  });

  // -- project keys as ticket prefixes --

  describe("getValidIdPrefixes", () => {
    async function connected() {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
    }

    it("fetches the project keys in the background, across pages", async () => {
      await connected();
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ values: [{ key: "OPS" }, { key: "eng" }], isLast: false }))
        .mockResolvedValueOnce(jsonResponse({ values: [{ key: "MKT" }, { key: "not a key" }, { key: "A".repeat(21) }], isLast: true }));

      expect(adapter.getValidIdPrefixes()).toEqual([]);
      await vi.waitFor(() => expect(adapter.getValidIdPrefixes()).toHaveLength(3));

      expect(adapter.getValidIdPrefixes()).toEqual(["OPS-", "ENG-", "MKT-"]);
      expect(mockFetch.mock.calls[1][0]).toBe("https://test.atlassian.net/rest/api/3/project/search?startAt=0&maxResults=50");
      expect(mockFetch.mock.calls[2][0]).toContain("startAt=2"); // advances by what the page held
      expect(mockFetch).toHaveBeenCalledTimes(3); // no refetch while the list is fresh
    });

    it("refreshes the list after an hour, and retries five minutes after a failure", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await connected();
        mockFetch.mockResolvedValueOnce(jsonResponse({ errorMessages: ["nope"] }, 500));
        adapter.getValidIdPrefixes();
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 0));

        adapter.getValidIdPrefixes();
        expect(mockFetch).toHaveBeenCalledTimes(2); // waiting before retrying
        vi.setSystemTime(Date.now() + 5 * 60 * 1000);
        mockFetch.mockResolvedValueOnce(jsonResponse({ values: [{ key: "OPS" }], isLast: true }));
        adapter.getValidIdPrefixes();
        await vi.waitFor(() => expect(adapter.getValidIdPrefixes()).toEqual(["OPS-"]));

        vi.setSystemTime(Date.now() + 59 * 60 * 1000);
        adapter.getValidIdPrefixes();
        expect(mockFetch).toHaveBeenCalledTimes(3);
        vi.setSystemTime(Date.now() + 2 * 60 * 1000);
        mockFetch.mockResolvedValueOnce(jsonResponse({ values: [{ key: "ENG" }], isLast: true }));
        adapter.getValidIdPrefixes();
        await vi.waitFor(() => expect(adapter.getValidIdPrefixes()).toEqual(["ENG-"]));
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses no prefixes from a site with more projects than it reads", async () => {
      await connected();
      mockFetch.mockImplementation(async () => jsonResponse({ values: Array.from({ length: 50 }, (_, i) => ({ key: `P${i}` })), isLast: false }));

      adapter.getValidIdPrefixes();
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(21));
      await new Promise((r) => setTimeout(r, 0));

      expect(adapter.getValidIdPrefixes()).toEqual([]);
      mockFetch.mockReset();
    });

    it("drops a list fetched for an earlier connection", async () => {
      await connected();
      let answer!: (r: Response) => void;
      mockFetch.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
      adapter.getValidIdPrefixes();

      await connected(); // reconnect while that fetch is still out
      answer(jsonResponse({ values: [{ key: "OLD" }], isLast: true }));
      await new Promise((r) => setTimeout(r, 0));

      mockFetch.mockResolvedValueOnce(jsonResponse({ values: [{ key: "NEW" }], isLast: true }));
      await vi.waitFor(() => expect(adapter.getValidIdPrefixes()).toEqual(["NEW-"]));
    });

    it("asks nothing with credentials that failed to verify", async () => {
      await connected();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
      await expect(adapter.connect(CREDENTIALS)).rejects.toThrow();
      mockFetch.mockClear();

      expect(adapter.getValidIdPrefixes()).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("asks Jira nothing before connecting", () => {
      expect(adapter.getValidIdPrefixes()).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
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

      const item = await adapter.getWorkItem("OPS-382");

      expect(item).not.toBeNull();
      expect(item!.id).toBe("OPS-382");
      expect(item!.title).toBe("Implement auth flow");
      expect(item!.status).toBe("In Progress");
      expect(item!.assignee).toBe("Relay");
      expect(item!.url).toBe("https://test.atlassian.net/browse/OPS-382");
      expect(item!.labels).toEqual(["backend", "auth"]);
      expect(item!.description).toBe("Build the OAuth authentication flow for the API.");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/OPS-382");
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

      const item = await adapter.getWorkItem("OPS-382");
      expect(item!.assignee).toBeNull();
    });

    it("should handle issue with null description", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, description: null } })),
      );

      const item = await adapter.getWorkItem("OPS-382");
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

      const item = await adapter.getWorkItem("OPS-382");
      expect(item!.description).toHaveLength(200);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.getWorkItem("OPS-1")).rejects.toThrow("not connected");
    });

    it("should throw JiraAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

      await expect(adapter.getWorkItem("OPS-382")).rejects.toThrow(JiraAuthError);
    });

    it("should throw JiraRateLimitError on 429", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({}, 429, { "Retry-After": "30" }),
      );

      await expect(adapter.getWorkItem("OPS-382")).rejects.toThrow(JiraRateLimitError);
    });

    it("should URL-encode issue IDs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(makeJiraIssue({ key: "OPS-1" })));

      await adapter.getWorkItem("OPS-1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/OPS-1");
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

      await adapter.updateWorkItem("OPS-382", { title: "New title" });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/3/issue/OPS-382");
      expect(options.method).toBe("PUT");
      const body = JSON.parse(options.body);
      expect(body.fields.summary).toBe("New title");
    });

    it("should update labels via PUT", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("OPS-382", { labels: ["urgent", "frontend"] });

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

      await adapter.updateWorkItem("OPS-382", { status: "Done" });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify GET transitions
      const [transUrl] = mockFetch.mock.calls[0];
      expect(transUrl).toContain("/rest/api/3/issue/OPS-382/transitions");

      // Verify POST transition
      const [postUrl, postOptions] = mockFetch.mock.calls[1];
      expect(postUrl).toContain("/rest/api/3/issue/OPS-382/transitions");
      expect(postOptions.method).toBe("POST");
      const body = JSON.parse(postOptions.body);
      expect(body.transition.id).toBe("31");
    });

    it("should match transition name case-insensitively", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "31", name: "Done" }] }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));

      await adapter.updateWorkItem("OPS-382", { status: "done" });

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.transition.id).toBe("31");
    });

    it("should throw when no matching transition exists", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "11", name: "To Do" }] }),
      );

      await expect(
        adapter.updateWorkItem("OPS-382", { status: "Cancelled" }),
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

      await adapter.updateWorkItem("OPS-382", { title: "Updated", status: "Done" });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.updateWorkItem("OPS-1", { title: "x" })).rejects.toThrow("not connected");
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
          issues: [makeJiraIssue(), makeJiraIssue({ key: "OPS-383", fields: { ...makeJiraIssue().fields, summary: "Another task" } })],
          total: 2,
        }),
      );

      const results = await adapter.searchWorkItems("auth");

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("OPS-382");
      expect(results[1].id).toBe("OPS-383");

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
        await adapter.getWorkItem("OPS-1");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(JiraRateLimitError);
        expect((e as JiraRateLimitError).retryAfter).toBe(45);
      }
    });

    it("should default Retry-After to 60 when header is missing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 429));

      try {
        await adapter.getWorkItem("OPS-1");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(JiraRateLimitError);
        expect((e as JiraRateLimitError).retryAfter).toBe(60);
      }
    });
  });

  // -- getComments --

  describe("getComments", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ displayName: "Op" }));
      await adapter.connect(CREDENTIALS);
      mockFetch.mockClear();
    });

    it("fetches and returns comments for a Jira issue", async () => {
      const mockResponse = {
        comments: [
          {
            id: "10001",
            author: { displayName: "Alice" },
            body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good to me" }] }] },
            created: "2026-03-31T10:00:00.000+0000",
          },
          {
            id: "10002",
            author: { displayName: "Bob" },
            body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }] },
            created: "2026-03-31T11:00:00.000+0000",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(mockResponse));

      const comments = await adapter.getComments("OPS-382");

      expect(comments).toHaveLength(2);
      expect(comments[0].author).toBe("Alice");
      expect(comments[0].body).toBe("Looks good to me");
      expect(comments[1].author).toBe("Bob");
    });

    it("returns empty array for 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errorMessages: ["not found"] }, 404));

      const comments = await adapter.getComments("NOPE-999");

      expect(comments).toEqual([]);
    });

    it("should throw if not connected", async () => {
      const fresh = new JiraAdapter();
      await expect(fresh.getComments("OPS-1")).rejects.toThrow("not connected");
    });
  });

  // -- getAuthenticatedUser --

  describe("JiraAdapter.getAuthenticatedUser", () => {
    it("returns null before connect", () => {
      const adapter = new JiraAdapter();
      expect(adapter.getAuthenticatedUser()).toBeNull();
    });

    it("returns userId and userName after connect with accountId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ displayName: "Operator", accountId: "acc-123", emailAddress: "op@example.com" }),
      );

      await adapter.connect(CREDENTIALS);

      expect(adapter.getAuthenticatedUser()).toEqual({
        userId: "acc-123",
        userName: "Operator",
      });
    });

    it("falls back to emailAddress when accountId is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ displayName: "Operator", emailAddress: "op@example.com" }),
      );

      await adapter.connect(CREDENTIALS);

      expect(adapter.getAuthenticatedUser()).toEqual({
        userId: "op@example.com",
        userName: "Operator",
      });
    });

    it("uses empty string for userId when neither accountId nor emailAddress present", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ displayName: "Operator" }),
      );

      await adapter.connect(CREDENTIALS);

      expect(adapter.getAuthenticatedUser()).toEqual({
        userId: "",
        userName: "Operator",
      });
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

      const item = await adapter.getWorkItem("OPS-382");
      expect(item!.description).toBe("Hello world");
    });

    it("should handle empty labels array", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(makeJiraIssue({ fields: { ...makeJiraIssue().fields, labels: [] } })),
      );

      const item = await adapter.getWorkItem("OPS-382");
      expect(item!.labels).toEqual([]);
    });
  });
});
