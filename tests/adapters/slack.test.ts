// tests/adapters/slack.test.ts — Tests for SlackAdapter

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackAdapter } from "../../core/adapters/messaging/slack/index.js";

// --- Mock @slack/web-api ---

const mockAuthTest = vi.fn();
const mockConversationsList = vi.fn();
const mockConversationsHistory = vi.fn();
const mockConversationsReplies = vi.fn();
const mockConversationsOpen = vi.fn();
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
        open: mockConversationsOpen,
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

    it("stops listing users once its signal aborts (a newer settings save replaced it)", async () => {
      const controller = new AbortController();
      // Two pages of users; the save is replaced while the first page is loading
      mockUsersList
        .mockImplementationOnce(async () => {
          controller.abort(new Error("replaced"));
          return { members: [], response_metadata: { next_cursor: "page-2" } };
        })
        .mockResolvedValue({ members: [], response_metadata: {} });

      await expect(adapter.connect({ token: "xoxp-valid-token" }, controller.signal)).rejects.toThrow();
      expect(mockUsersList).toHaveBeenCalledTimes(1);
      expect(mockConversationsList).not.toHaveBeenCalled();
    });

    it("doesn't retry a rate-limited page after its signal aborts", async () => {
      const controller = new AbortController();
      mockUsersList.mockImplementationOnce(async () => {
        setTimeout(() => controller.abort(new Error("replaced")), 10);
        throw Object.assign(new Error("ratelimited"), { code: "slack_webapi_rate_limited", retryAfter: 1 });
      });

      const started = Date.now();
      await expect(adapter.connect({ token: "xoxp-valid-token" }, controller.signal)).rejects.toThrow("replaced");
      expect(Date.now() - started).toBeLessThan(500); // the 1s Retry-After wait is cut short
      expect(mockUsersList).toHaveBeenCalledTimes(1); // and the page isn't retried
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

    it("skips a channel that no longer exists instead of failing the whole poll", async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: "CGONE", name: "deleted" }, { id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      const gone = Object.assign(new Error("An API error occurred: channel_not_found"), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "channel_not_found" },
      });
      mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
        if (channel === "CGONE") throw gone;
        return { messages: [makeSlackMessage({ ts: "1700000001.000100" })], response_metadata: { next_cursor: "" } };
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads.map((t) => t.channelId)).toEqual(["C001"]);
    });

    it("reads a channel quiet for a day only every 5 minutes, and an active one every poll", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
        mockConversationsList.mockResolvedValue({
          channels: [{ id: "CBUSY", name: "busy" }, { id: "CQUIET", name: "quiet" }],
          response_metadata: { next_cursor: "" },
        });
        const recentTs = String(new Date("2026-10-13T11:00:00Z").getTime() / 1000);
        mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => ({
          messages: channel === "CBUSY" ? [makeSlackMessage({ ts: recentTs })] : [],
          response_metadata: { next_cursor: "" },
        }));
        const readChannels = () => mockConversationsHistory.mock.calls.map((c) => c[0].channel);

        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));
        expect(readChannels()).toEqual(["CBUSY", "CQUIET"]);

        mockConversationsHistory.mockClear();
        vi.setSystemTime(new Date("2026-10-13T12:01:00Z"));
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));
        expect(readChannels()).toEqual(["CBUSY"]);

        mockConversationsHistory.mockClear();
        vi.setSystemTime(new Date("2026-10-13T12:06:00Z"));
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));
        expect(readChannels()).toEqual(["CBUSY", "CQUIET"]);
      } finally {
        vi.useRealTimers();
      }
    });

    describe("quiet channels that fall due together", () => {
      const ids = Array.from({ length: 20 }, (_, i) => `CQ${String(i).padStart(2, "0")}`);
      const since = new Date("2026-10-10T00:00:00Z");
      const at = (time: string) => vi.setSystemTime(new Date(`2026-10-13T${time}Z`));
      const readChannels = () => mockConversationsHistory.mock.calls.map((c) => c[0].channel);
      const listChannels = (list: string[]) =>
        mockConversationsList.mockResolvedValue({ channels: list.map((id) => ({ id, name: id })), response_metadata: { next_cursor: "" } });

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        mockConversationsHistory.mockResolvedValue({ messages: [], response_metadata: { next_cursor: "" } });
      });
      afterEach(() => vi.useRealTimers());

      it("are spread over several polls, most overdue first, while an active channel is read every poll", async () => {
        const recent = new Map([["CBUSY", new Date("2026-10-13T11:00:00Z")]]);
        // Two groups read a minute apart: CQ10..CQ19 first, then CQ00..CQ09
        listChannels(ids.slice(10));
        at("12:00:00");
        await adapter.readThreads(since);
        listChannels(["CBUSY", ...ids]);
        at("12:01:00");
        await adapter.readThreads(since, undefined, recent);

        mockConversationsHistory.mockClear();
        at("12:06:00"); // every quiet channel is due; the cap takes the ten read first, then five more
        await adapter.readThreads(since, undefined, recent);
        expect(readChannels()).toEqual(["CBUSY", ...ids.slice(0, 5), ...ids.slice(10)]);

        mockConversationsHistory.mockClear();
        at("12:06:30");
        await adapter.readThreads(since, undefined, recent);
        expect(readChannels()).toEqual(["CBUSY", ...ids.slice(5, 10)]); // the rest, before any is read again
      });

      it("keep their place in the queue when the poll fails", async () => {
        listChannels(ids);
        at("12:00:00");
        await adapter.readThreads(since);

        at("12:05:00");
        mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
          if (channel === "CQ03") throw Object.assign(new Error("invalid_auth"), { data: { ok: false, error: "invalid_auth" } });
          return { messages: [], response_metadata: { next_cursor: "" } };
        });
        await expect(adapter.readThreads(since)).rejects.toThrow("invalid_auth");

        mockConversationsHistory.mockClear();
        mockConversationsHistory.mockResolvedValue({ messages: [], response_metadata: { next_cursor: "" } });
        at("12:05:30");
        await adapter.readThreads(since);
        expect(readChannels()).toEqual(ids.slice(0, 15)); // the failed poll's threads were dropped, so they're read again
      });

      it("go ahead of channels that can't be read", async () => {
        const gone = Object.assign(new Error("not_in_channel"), { data: { ok: false, error: "not_in_channel" } });
        mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
          if (channel < "CQ05") throw gone;
          return { messages: [], response_metadata: { next_cursor: "" } };
        });
        listChannels(ids);
        at("12:00:00");
        await adapter.readThreads(since);

        mockConversationsHistory.mockClear();
        at("12:05:00");
        await adapter.readThreads(since);
        expect(readChannels()).toEqual(ids.slice(5));
      });

      it("retry a channel that couldn't be read every 30 minutes, even with a backlog of due quiet channels", async () => {
        let gone = true;
        mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
          if (channel === "CGONE" && gone) throw Object.assign(new Error("not_in_channel"), { data: { ok: false, error: "not_in_channel" } });
          return { messages: [], response_metadata: { next_cursor: "" } };
        });
        listChannels(["CGONE", ...ids]);
        at("12:00:00");
        await adapter.readThreads(since);
        gone = false; // e.g. the operator is invited back

        const goneReads: string[] = [];
        for (const time of ["12:01:00", "12:06:00", "12:11:00", "12:16:00", "12:21:00", "12:26:00", "12:31:00"]) {
          mockConversationsHistory.mockClear();
          at(time);
          await adapter.readThreads(since);
          if (readChannels().includes("CGONE")) goneReads.push(time);
          expect(readChannels().length).toBeLessThanOrEqual(15);
        }
        expect(goneReads).toEqual(["12:31:00"]); // not every poll, and not never
      });
    });

    it("still fails the poll on errors that aren't about one channel", async () => {
      mockConversationsList.mockResolvedValue({ channels: [{ id: "C001", name: "general" }], response_metadata: { next_cursor: "" } });
      mockConversationsHistory.mockRejectedValue(Object.assign(new Error("invalid_auth"), { data: { ok: false, error: "invalid_auth" } }));
      await expect(adapter.readThreads(new Date("2024-01-01"))).rejects.toThrow("invalid_auth");
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
          { id: "C002", name: "fleet-ops" },
        ],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [],
        response_metadata: { next_cursor: "" },
      });

      await adapter.readThreads(new Date("2024-01-01"), ["#fleet-ops"]);

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
          { ts: "1711900000.000000", user: "U1", text: "Starting work on OPS-382" },
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
        ["U1", { name: "Relay", avatar: "" }],
        ["U2", { name: "Prism", avatar: "" }],
      ]);

      const messages = await adapter.getThreadMessages("1711900000.000000", "C123");

      expect(messages).toHaveLength(3);
      expect(messages[0].userName).toBe("Relay");
      expect(messages[0].text).toBe("Starting work on OPS-382");
      expect(messages[2].text).toBe("Approved and merged");
    });
  });

  // -- postMessage --

  describe("postMessage", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("posts a top-level message without thread_ts", async () => {
      mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1711900000.000100" });

      const result = await adapter.postMessage("C001", "Hello channel");

      expect(mockChatPostMessage).toHaveBeenCalledWith({
        channel: "C001",
        text: "Hello channel",
        as_user: true,
      });
      expect(result.threadId).toBe("1711900000.000100");
    });
  });

  // -- sendDirectMessage --

  describe("sendDirectMessage", () => {
    beforeEach(async () => {
      await adapter.connect({ token: "xoxp-valid-token" });
    });

    it("opens a DM and posts a message", async () => {
      mockConversationsOpen.mockResolvedValue({
        ok: true,
        channel: { id: "D001" },
      });
      mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1711900100.000200" });

      const result = await adapter.sendDirectMessage("U123", "Hey there");

      expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U123" });
      expect(mockChatPostMessage).toHaveBeenCalledWith({
        channel: "D001",
        text: "Hey there",
        as_user: true,
      });
      expect(result.channelId).toBe("D001");
      expect(result.threadId).toBe("1711900100.000200");
    });
  });

  describe("parseThreadUrl", () => {
    it("parses a valid Slack thread URL", () => {
      const result = adapter.parseThreadUrl("https://team.slack.com/archives/C001/p1711900000000100");
      expect(result).toEqual({ threadId: "1711900000.000100", channelId: "C001" });
    });

    it("returns null for non-Slack URLs", () => {
      expect(adapter.parseThreadUrl("https://google.com")).toBeNull();
    });

    it("returns null for malformed Slack URLs", () => {
      expect(adapter.parseThreadUrl("https://team.slack.com/messages/foo")).toBeNull();
    });
  });

  // -- senderType --

  describe("senderType", () => {
    it("populates senderType based on is_bot from Slack user data", async () => {
      // Re-connect with bot and human users pre-loaded
      mockUsersList.mockResolvedValueOnce({
        members: [
          { id: "U001", name: "relay", is_bot: true, profile: { display_name: "Relay" } },
          { id: "U002", name: "alex", is_bot: false, profile: { display_name: "Alex" } },
        ],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsList.mockResolvedValueOnce({
        channels: [],
        response_metadata: { next_cursor: "" },
      });
      await adapter.connect({ token: "xoxp-valid-token" });

      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          makeSlackMessage({ ts: "1700000001.000100", user: "U001", text: "Bot message" }),
          makeSlackMessage({ ts: "1700000002.000200", user: "U002", text: "Human message" }),
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(2);
      const botMsg = threads.find((t) => t.messages[0].userId === "U001")!.messages[0];
      const humanMsg = threads.find((t) => t.messages[0].userId === "U002")!.messages[0];
      expect(botMsg.senderType).toBe("agent");
      expect(humanMsg.senderType).toBe("human");
    });

    it("sets senderType to unknown for messages from users not in userInfoMap", async () => {
      await adapter.connect({ token: "xoxp-valid-token" });

      mockConversationsList.mockResolvedValue({
        channels: [{ id: "C001", name: "general" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          makeSlackMessage({ ts: "1700000001.000100", user: "UNKNOWN_USER", text: "Mystery message" }),
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2024-01-01"));

      expect(threads).toHaveLength(1);
      expect(threads[0].messages[0].senderType).toBe("unknown");
    });

    it("populates senderType in getThreadMessages", async () => {
      const localAdapter = new SlackAdapter();
      (localAdapter as any).client = {
        auth: { test: vi.fn().mockResolvedValue({ user: "test", team: "test", url: "https://test.slack.com/" }) },
        conversations: {
          list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
          replies: vi.fn().mockResolvedValue({
            ok: true,
            messages: [
              { ts: "1711900000.000000", user: "U_BOT", text: "Agent says hi" },
              { ts: "1711900100.000000", user: "U_HUMAN", text: "Human says hi" },
            ],
            response_metadata: {},
          }),
        },
        users: { list: vi.fn().mockResolvedValue({ members: [], response_metadata: {} }) },
      };
      (localAdapter as any).channelMap = new Map([["C123", { name: "test", isPrivate: false }]]);
      (localAdapter as any).userInfoMap = new Map([
        ["U_BOT", { name: "Relay", avatar: "", isBot: true }],
        ["U_HUMAN", { name: "Alex", avatar: "", isBot: false }],
      ]);

      const messages = await localAdapter.getThreadMessages("1711900000.000000", "C123");

      expect(messages[0].senderType).toBe("agent");
      expect(messages[1].senderType).toBe("human");
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
