// tests/adapters/slack.test.ts — Tests for SlackAdapter

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../../core/adapters/platforms/slack/index.js";

// --- Mock @slack/web-api ---

const mockAuthTest = vi.fn();
const mockConversationsList = vi.fn();
const mockConversationsHistory = vi.fn();
const mockConversationsReplies = vi.fn();
const mockChatPostMessage = vi.fn();
const mockUsersList = vi.fn();

vi.mock("@slack/web-api", () => {
  return {
    WebClient: class MockWebClient {
      auth = { test: mockAuthTest };
      conversations = {
        list: mockConversationsList,
        history: mockConversationsHistory,
        replies: mockConversationsReplies,
      };
      chat = { postMessage: mockChatPostMessage };
      users = { list: mockUsersList };
    },
  };
});

// --- Helpers ---

function makeSlackMessage(overrides: Record<string, unknown> = {}) {
  return {
    ts: "1700000001.000100",
    text: "Hello from agent",
    user: "U001",
    ...overrides,
  };
}

// --- Tests ---

describe("SlackAdapter", () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SlackAdapter();
    mockAuthTest.mockResolvedValue({ user: "operator", team: "test-team", url: "https://test-team.slack.com/" });
    // connect() now pre-fetches users and channels — provide defaults
    mockUsersList.mockResolvedValue({ members: [], response_metadata: {} });
    mockConversationsList.mockResolvedValue({ channels: [], response_metadata: {} });
  });

  // -- connect --

  describe("connect", () => {
    it("should connect with a valid xoxp- token", async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
      expect(mockAuthTest).toHaveBeenCalledOnce();
    });

    it("should reject tokens that are not xoxp-", async () => {
      await expect(adapter.connect({ token: "xoxb-bot-token" })).rejects.toThrow(
        "xoxp- user token",
      );
      expect(mockAuthTest).not.toHaveBeenCalled();
    });

    it("should reject empty tokens", async () => {
      await expect(adapter.connect({ token: "" })).rejects.toThrow("xoxp- user token");
    });

    it("should throw when auth.test fails", async () => {
      mockAuthTest.mockRejectedValue(new Error("invalid_auth"));
      await expect(adapter.connect({ token: "xoxp-bad" })).rejects.toThrow("Slack auth failed");
    });
  });

  // -- readThreads --

  describe("readThreads", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("should read standalone messages as single-message threads", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [makeSlackMessage({ ts: "1700000001.000100" })],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("1700000001.000100");
      expect(threads[0].channelId).toBe("C001");
      expect(threads[0].channelName).toBe("general");
      expect(threads[0].platform).toBe("slack");
      expect(threads[0].messages).toHaveLength(1);
      expect(threads[0].messages[0].text).toBe("Hello from agent");
    });

    it("should fetch thread replies for messages with reply_count > 0", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          makeSlackMessage({
            ts: "1700000001.000100",
            thread_ts: "1700000001.000100",
            reply_count: 2,
          }),
        ],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsReplies.mockResolvedValue({
        messages: [
          makeSlackMessage({ ts: "1700000001.000100", thread_ts: "1700000001.000100", text: "Parent" }),
          makeSlackMessage({ ts: "1700000002.000200", thread_ts: "1700000001.000100", user: "U002", text: "Reply 1" }),
          makeSlackMessage({ ts: "1700000003.000300", thread_ts: "1700000001.000100", user: "U003", text: "Reply 2" }),
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(1);
      expect(threads[0].messages).toHaveLength(3);
      expect(threads[0].messageCount).toBe(3);
      expect(threads[0].messages[2].text).toBe("Reply 2");
    });

    it("should use specified channels instead of listing all", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [
          { id: "C001", name: "general" },
          { id: "C002", name: "agent-orchestrator" },
        ],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [],
        response_metadata: { next_cursor: "" },
      });

      await adapter.readThreads(new Date("2024-01-01"), ["#agent-orchestrator"]);

      // Should only fetch history for C002
      expect(mockConversationsHistory).toHaveBeenCalledOnce();
      expect(mockConversationsHistory).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "C002" }),
      );
    });

    it("should handle pagination in conversations.history", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory
        .mockResolvedValueOnce({
          messages: [makeSlackMessage({ ts: "1700000001.000100" })],
          response_metadata: { next_cursor: "page2" },
        })
        .mockResolvedValueOnce({
          messages: [makeSlackMessage({ ts: "1700000002.000200", text: "Second page" })],
          response_metadata: { next_cursor: "" },
        });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(2);
      expect(mockConversationsHistory).toHaveBeenCalledTimes(2);
    });

    it("should skip channel_join and channel_leave subtypes", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          makeSlackMessage({ ts: "1700000001.000100", subtype: "channel_join" }),
          makeSlackMessage({ ts: "1700000002.000200", text: "Real message" }),
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(1);
      expect(threads[0].messages[0].text).toBe("Real message");
    });

    it("should skip reply messages (thread_ts !== ts without reply_count)", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          // A reply that appears in history (thread_ts != ts, no reply_count)
          makeSlackMessage({
            ts: "1700000002.000200",
            thread_ts: "1700000001.000100",
            text: "I am a reply",
          }),
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(0);
    });
  });

  // -- replyToThread --

  describe("replyToThread", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("should call chat.postMessage with correct arguments", async () => {
      mockChatPostMessage.mockResolvedValue({ ok: true });

      await adapter.replyToThread("1700000001.000100", "C001", "Approved, go ahead");

      expect(mockChatPostMessage).toHaveBeenCalledWith({
        channel: "C001",
        text: "Approved, go ahead",
        thread_ts: "1700000001.000100",
        as_user: true,
      });
    });
  });

  // -- streamMessages --

  describe("streamMessages", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("should call the handler for each message when readThreads is called", async () => {
      const handler = vi.fn();
      adapter.streamMessages(handler);

      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          makeSlackMessage({ ts: "1700000001.000100", text: "msg1" }),
          makeSlackMessage({ ts: "1700000002.000200", text: "msg2" }),
        ],
        response_metadata: { next_cursor: "" },
      });

      await adapter.readThreads(new Date("2024-01-01"));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ text: "msg1" }),
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ text: "msg2" }),
      );
    });
  });

  // -- getUsers --

  describe("getUsers", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
      // Clear call counts from connect()'s pre-fetch
      mockUsersList.mockClear();
    });

    it("should return userId -> displayName map", async () => {
      mockUsersList.mockResolvedValue({
        members: [
          { id: "U001", real_name: "Alice", profile: { display_name: "alice" } },
          { id: "U002", real_name: "Bob", profile: { display_name: "" } },
          { id: "U003", real_name: "", profile: { display_name: "charlie" } },
        ],
        response_metadata: { next_cursor: "" },
      });

      const users = await adapter.getUsers();

      expect(users.get("U001")).toBe("alice");
      expect(users.get("U002")).toBe("Bob"); // fallback to real_name
      expect(users.get("U003")).toBe("charlie");
    });

    it("should handle pagination in users.list", async () => {
      mockUsersList
        .mockResolvedValueOnce({
          members: [{ id: "U001", real_name: "Alice", profile: { display_name: "alice" } }],
          response_metadata: { next_cursor: "page2" },
        })
        .mockResolvedValueOnce({
          members: [{ id: "U002", real_name: "Bob", profile: { display_name: "bob" } }],
          response_metadata: { next_cursor: "" },
        });

      const users = await adapter.getUsers();

      expect(users.size).toBe(2);
      expect(mockUsersList).toHaveBeenCalledTimes(2);
    });
  });

  // -- Rate limiting --

  describe("rate limiting", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
      // Clear call counts from connect()'s pre-fetch
      mockUsersList.mockClear();
    });

    it("should retry on rate limit and succeed", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), {
        code: "slack_webapi_rate_limited",
        data: { retryAfter: 0 }, // 0s for fast tests
      });

      mockUsersList
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          members: [{ id: "U001", real_name: "Alice", profile: { display_name: "alice" } }],
          response_metadata: { next_cursor: "" },
        });

      const users = await adapter.getUsers();

      expect(users.get("U001")).toBe("alice");
      expect(mockUsersList).toHaveBeenCalledTimes(2);
    });

    it("should throw after max retries on persistent rate limiting", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), {
        code: "slack_webapi_rate_limited",
        data: { retryAfter: 0 },
      });

      mockUsersList.mockRejectedValue(rateLimitError);

      await expect(adapter.getUsers()).rejects.toThrow("rate limited");
      // 1 initial + 3 retries = 4 calls
      expect(mockUsersList).toHaveBeenCalledTimes(4);
    });
  });

  // -- getThreadMessages --

  describe("getThreadMessages", () => {
    it("returns messages for a specific thread", async () => {
      // Mock the conversations.replies API call
      const mockReplies = {
        ok: true,
        messages: [
          { ts: "1711900000.000000", user: "U1", text: "Starting work on AI-382" },
          { ts: "1711900100.000000", user: "U2", text: "PR submitted for review" },
          { ts: "1711900200.000000", user: "U1", text: "Approved and merged" },
        ],
        response_metadata: {},
      };

      // Use the existing mock pattern from the test file
      const adapter = new SlackAdapter();
      // Connect with mocked client
      const mockClient = {
        auth: { test: vi.fn().mockResolvedValue({ user: "test", team: "test", url: "https://test.slack.com/" }) },
        conversations: {
          list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
          replies: vi.fn().mockResolvedValue(mockReplies),
        },
        users: { list: vi.fn().mockResolvedValue({ members: [], response_metadata: {} }) },
      };
      (adapter as any).client = mockClient;
      (adapter as any).channelMap = new Map([["C123", { name: "test", isPrivate: false }]]);
      (adapter as any).userInfoMap = new Map([
        ["U1", { name: "Byte", avatar: "" }],
        ["U2", { name: "Pixel", avatar: "" }],
      ]);

      const messages = await adapter.getThreadMessages("1711900000.000000", "C123");

      expect(messages).toHaveLength(3);
      expect(messages[0].userName).toBe("Byte");
      expect(messages[0].text).toBe("Starting work on AI-382");
      expect(messages[2].text).toBe("Approved and merged");
    });
  });

  // -- Error handling --

  describe("error handling", () => {
    it("should throw if not connected", async () => {
      const disconnected = new SlackAdapter();
      await expect(disconnected.readThreads(new Date())).rejects.toThrow("not connected");
      await expect(disconnected.replyToThread("ts", "ch", "msg")).rejects.toThrow("not connected");
      await expect(disconnected.getUsers()).rejects.toThrow("not connected");
    });
  });
});
