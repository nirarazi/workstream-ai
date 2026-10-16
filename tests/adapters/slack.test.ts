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
const mockBotsInfo = vi.fn();

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
      bots = { info: mockBotsInfo };
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

      it("put DMs ahead of channels due at the same time", async () => {
        const dms = ["DM1", "DM2", "DM3", "DM4", "DM5"];
        mockConversationsList.mockResolvedValue({
          channels: [...ids.map((id) => ({ id, name: id })), ...dms.map((id) => ({ id, is_im: true, user: "U-relay" }))],
          response_metadata: { next_cursor: "" },
        });
        at("12:00:00");
        await adapter.readThreads(since);

        mockConversationsHistory.mockClear();
        at("12:05:00"); // all 25 due together: the DMs go first, then the oldest channels
        await adapter.readThreads(since);
        expect(readChannels()).toEqual([...ids.slice(0, 10), ...dms]); // read in list order; the set is what matters

        mockConversationsHistory.mockClear();
        at("12:10:00"); // CQ10..19 waited since 12:00; the DMs since 12:05, plus their head start: level, so all 15 fit
        await adapter.readThreads(since);
        expect(readChannels()).toEqual([...ids.slice(10), ...dms]);
      });

      it("never let DMs keep a channel that has waited longer from being read", async () => {
        const dms = Array.from({ length: 30 }, (_, i) => `DM${String(i).padStart(2, "0")}`);
        mockConversationsList.mockResolvedValue({
          channels: [...dms.map((id) => ({ id, is_im: true, user: "U-relay" })), { id: "CQ00", name: "planning" }],
          response_metadata: { next_cursor: "" },
        });
        at("12:00:00");
        await adapter.readThreads(since);

        const readTimes: string[] = [];
        // Five minutes apart, so the DMs are always due again: more of them than one poll reads
        for (const time of ["12:05:00", "12:10:00", "12:15:00", "12:20:00"]) {
          mockConversationsHistory.mockClear();
          at(time);
          await adapter.readThreads(since);
          if (readChannels().includes("CQ00")) readTimes.push(time);
        }
        // Behind the DMs for a while, but not for ever (it's listed last, so it also loses the 12:15 tie)
        expect(readTimes).toEqual(["12:20:00"]);
      });

      it("don't give group DMs a head start", async () => {
        mockConversationsList.mockResolvedValue({
          channels: [...ids.map((id) => ({ id, name: id })), { id: "GDM1", is_mpim: true, name: "mpdm-dana--alex-1" }],
          response_metadata: { next_cursor: "" },
        });
        at("12:00:00");
        await adapter.readThreads(since);
        mockConversationsHistory.mockClear();
        at("12:05:00");
        await adapter.readThreads(since);
        expect(readChannels()).toEqual(ids.slice(0, 15));
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
        // CGONE was active until the operator left it, so its cursor alone doesn't make it quiet
        const left = new Map([["CGONE", new Date("2026-10-13T11:50:00Z")]]);
        await adapter.readThreads(since, undefined, left);
        gone = false; // e.g. the operator is invited back

        const goneReads: string[] = [];
        for (const time of ["12:01:00", "12:06:00", "12:11:00", "12:16:00", "12:21:00", "12:26:00", "12:31:00"]) {
          mockConversationsHistory.mockClear();
          at(time);
          await adapter.readThreads(since, undefined, left);
          if (readChannels().includes("CGONE")) goneReads.push(time);
          expect(readChannels().length).toBeLessThanOrEqual(15);
        }
        expect(goneReads).toEqual(["12:31:00"]); // not every poll, and not never
      });
    });

    describe("reads fitted to the poll interval", () => {
      const since = new Date("2026-10-10T00:00:00Z");
      const at = (time: string) => vi.setSystemTime(new Date(`2026-10-13T${time}Z`));
      const readChannels = () => mockConversationsHistory.mock.calls.map((c) => c[0].channel as string);
      const listChannels = (list: string[]) =>
        mockConversationsList.mockResolvedValue({ channels: list.map((id) => ({ id, name: id })), response_metadata: { next_cursor: "" } });
      const named = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
      const busySince = (list: string[]) => new Map(list.map((id) => [id, new Date("2026-10-13T11:00:00Z")]));
      const every30s = { pollIntervalMs: 30_000 }; // 50 history calls a minute: 25 a poll

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        mockConversationsHistory.mockResolvedValue({ messages: [], response_metadata: { next_cursor: "" } });
      });
      afterEach(() => vi.useRealTimers());

      it("lets busy channels take turns when more are active than fit, so every one is read every other poll", async () => {
        const busy = named("CA", 30);
        listChannels(busy);
        const cursors = busySince(busy);

        const polls: string[][] = [];
        for (const time of ["12:00:00", "12:00:30", "12:01:00"]) {
          mockConversationsHistory.mockClear();
          at(time);
          await adapter.readThreads(since, undefined, cursors, every30s);
          polls.push(readChannels());
        }

        for (const poll of polls) expect(poll).toHaveLength(25); // no quiet channel is due, so none are set aside
        expect(new Set([...polls[0], ...polls[1]])).toEqual(new Set(busy));
        expect(polls[1]).toEqual(expect.arrayContaining(busy.slice(25))); // the ones left out come first
      });

      it("still reads some quiet channels when busy ones would fill the poll", async () => {
        const busy = named("CA", 30);
        const quiet = named("CQ", 10);
        listChannels(quiet);
        at("12:00:00");
        await adapter.readThreads(since, undefined, undefined, every30s);
        listChannels([...busy, ...quiet]);

        mockConversationsHistory.mockClear();
        at("12:06:00"); // every quiet channel is due
        await adapter.readThreads(since, undefined, busySince(busy), every30s);

        expect(readChannels().filter((id) => id.startsWith("CQ"))).toHaveLength(5);
        expect(readChannels()).toHaveLength(25);
      });

      it("reads more quiet channels per poll when few are busy", async () => {
        const quiet = named("CQ", 20);
        listChannels(quiet);
        at("12:00:00");
        await adapter.readThreads(since, undefined, undefined, every30s);
        listChannels(["CBUSY", ...quiet]);

        mockConversationsHistory.mockClear();
        at("12:06:00");
        await adapter.readThreads(since, undefined, busySince(["CBUSY"]), every30s);

        expect(readChannels()).toHaveLength(21); // all 20 due, not just the 15 an unknown interval allows
      });

      it("allows proportionally more reads for a longer interval", async () => {
        const busy = named("CA", 60);
        listChannels(busy);
        at("12:00:00");

        await adapter.readThreads(since, undefined, busySince(busy), { pollIntervalMs: 60_000 });

        expect(readChannels()).toHaveLength(50); // 50 a minute
      });

      it("doesn't let a flood of new conversations crowd out the ones already being read", async () => {
        const busy = named("CA", 24);
        const dm = "DAGENT";
        let fresh = 0;
        const flood = () => Array.from({ length: 20 }, () => `GNEW${fresh++}`);
        const known = [...busy, dm];
        const cursors = busySince([...known]);
        mockConversationsList.mockImplementation(async () => ({
          channels: [...known.map((id) => ({ id, name: id, is_im: id === dm })), ...flood().map((id) => ({ id, name: id, is_mpim: true }))],
          response_metadata: { next_cursor: "" },
        }));

        let dmReads = 0;
        // A minute apart, so the test's frozen clock never has the rate limiter wait
        const times = ["12:00:00", "12:01:00", "12:02:00", "12:03:00", "12:04:00", "12:05:00"];
        try {
          for (const time of times) {
            mockConversationsHistory.mockClear();
            at(time);
            await adapter.readThreads(since, undefined, cursors, every30s);
            if (readChannels().includes(dm)) dmReads++;
            for (const id of readChannels().filter((c) => c.startsWith("GNEW"))) cursors.set(id, new Date("2026-10-13T11:00:00Z"));
          }
        } finally {
          mockConversationsList.mockReset();
        }

        expect(dmReads).toBe(times.length); // a DM already being read keeps its head start
      });

      it("spends late-reply reads only on channels this poll reads", async () => {
        const busy = named("CA", 60);
        listChannels(busy);
        const windowStart = new Date("2026-10-13T00:00:00Z");
        const wideOldest = String(windowStart.getTime() / 1000);
        const knownThreads = new Map([["1791000000.000001", { latestAt: "2026-10-13T01:00:00.000Z", messageCount: 1 }]]);
        const options = { ...every30s, knownThreads, replyWindowStart: windowStart };

        for (const time of ["12:00:00", "12:01:00"]) { // the second poll reads a different 25 channels
          mockConversationsHistory.mockClear();
          at(time);
          await adapter.readThreads(since, undefined, busySince(busy), options);
          expect(mockConversationsHistory.mock.calls.filter((c) => c[0].oldest === wideOldest)).toHaveLength(5);
        }
      });
    });

    describe("late replies to known threads", () => {
      const ts = (iso: string) => String(Date.parse(iso) / 1000);
      const now = "2026-10-13T12:00:00Z";
      const windowStart = new Date("2026-10-10T12:00:00Z");
      const cursor = new Date("2026-10-13T11:00:00Z");
      const historyOldest = (channel: string) =>
        mockConversationsHistory.mock.calls.filter((c) => c[0].channel === channel).map((c) => c[0].oldest);
      // Like Slack: history only returns messages at or after `oldest`
      const history = (byChannel: Record<string, Array<Record<string, unknown>>>) =>
        mockConversationsHistory.mockImplementation(async ({ channel, oldest }: { channel: string; oldest: string }) => ({
          messages: (byChannel[channel] ?? []).filter((m) => parseFloat(m.ts as string) >= parseFloat(oldest)),
          response_metadata: { next_cursor: "" },
        }));

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(now));
      });
      afterEach(() => vi.useRealTimers());

      it("reads back to the reply window and returns only known threads with a newer reply", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
        const replied = ts("2026-10-11T09:00:00Z"); // done two days ago, got a late reply
        const unchanged = ts("2026-10-11T10:00:00Z");
        const unknown = ts("2026-10-12T09:00:00Z"); // never processed: left alone
        const fresh = ts("2026-10-13T11:30:00Z"); // after the cursor: read as usual
        history({
          C1: [
            makeSlackMessage({ ts: fresh }),
            makeSlackMessage({ ts: unknown }),
            makeSlackMessage({ ts: unchanged, thread_ts: unchanged, reply_count: 1, latest_reply: ts("2026-10-11T10:05:00Z") }),
            makeSlackMessage({ ts: replied, thread_ts: replied, reply_count: 2, latest_reply: ts("2026-10-13T11:45:00Z") }),
          ],
        });
        mockConversationsReplies.mockResolvedValue({
          messages: [makeSlackMessage({ ts: replied }), makeSlackMessage({ ts: ts("2026-10-11T09:10:00Z"), thread_ts: replied }), makeSlackMessage({ ts: ts("2026-10-13T11:45:00Z"), thread_ts: replied, text: "Blocked again" })],
          response_metadata: { next_cursor: "" },
        });
        const knownThreads = new Map([
          [replied, { latestAt: "2026-10-11T09:10:00.000Z", messageCount: 2 }],
          [unchanged, { latestAt: "2026-10-11T10:05:00.000Z", messageCount: 2 }],
        ]);

        const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, new Map([["C1", cursor]]), { knownThreads, replyWindowStart: windowStart });

        expect(historyOldest("C1")).toEqual([String(windowStart.getTime() / 1000)]);
        expect(mockConversationsReplies.mock.calls.map((c) => c[0].ts)).toEqual([replied]);
        expect(threads.map((t) => t.id).sort()).toEqual([fresh, replied].sort());
        expect(threads.find((t) => t.id === replied)!.messages.map((m) => m.text)).toContain("Blocked again");
      });

      it("doesn't read back to the window when no thread is known yet (a fresh install)", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
        history({});
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, new Map([["C1", cursor]]), { knownThreads: new Map(), replyWindowStart: windowStart });
        expect(historyOldest("C1")).toEqual([String(cursor.getTime() / 1000)]);
      });

      it("keeps a channel's turn to be read back when the poll fails", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }, { id: "C2", name: "planning" }], response_metadata: { next_cursor: "" } });
        const knownThreads = new Map([["1700000000.000000", { latestAt: "2023-11-14T22:13:20.000Z", messageCount: 1 }]]);
        const cursors = new Map([["C1", cursor], ["C2", cursor]]);
        mockConversationsHistory.mockImplementation(async ({ channel }: { channel: string }) => {
          if (channel === "C2") throw Object.assign(new Error("invalid_auth"), { data: { ok: false, error: "invalid_auth" } });
          return { messages: [], response_metadata: { next_cursor: "" } };
        });
        await expect(adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, cursors, { knownThreads, replyWindowStart: windowStart })).rejects.toThrow();

        mockConversationsHistory.mockClear();
        history({});
        vi.setSystemTime(new Date("2026-10-13T12:00:30Z"));
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, cursors, { knownThreads, replyWindowStart: windowStart });
        expect(historyOldest("C1")).toEqual([String(windowStart.getTime() / 1000)]); // read back again: the failed poll was dropped
      });

      it("counts a reply in the same millisecond as the last one processed as already seen", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
        const parent = ts("2026-10-13T11:10:00Z");
        history({ C1: [makeSlackMessage({ ts: parent, thread_ts: parent, reply_count: 1, latest_reply: "1792235000.123456" })] });
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, new Map([["C1", cursor]]), {
          knownThreads: new Map([[parent, { latestAt: new Date(1792235000123).toISOString(), messageCount: 2 }]]),
        });
        expect(mockConversationsReplies).not.toHaveBeenCalled();
      });

      it("doesn't fetch the replies of a known thread with nothing new", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
        const parent = ts("2026-10-13T11:10:00Z");
        history({ C1: [makeSlackMessage({ ts: parent, thread_ts: parent, reply_count: 3, latest_reply: ts("2026-10-13T11:20:00Z") })] });

        const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, new Map([["C1", cursor]]), {
          knownThreads: new Map([[parent, { latestAt: "2026-10-13T11:20:00.000Z", messageCount: 4 }]]),
        });

        expect(mockConversationsReplies).not.toHaveBeenCalled();
        expect(threads.map((t) => t.messages.length)).toEqual([1]); // just the parent, already processed
      });

      it("fetches a known thread in full when it has more messages than were processed (one was missed)", async () => {
        mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
        const parent = ts("2026-10-11T09:00:00Z"); // behind the cursor
        history({ C1: [makeSlackMessage({ ts: parent, thread_ts: parent, reply_count: 2, latest_reply: ts("2026-10-11T09:20:00Z") })] });
        mockConversationsReplies.mockResolvedValue({ messages: [makeSlackMessage({ ts: parent })], response_metadata: { next_cursor: "" } });

        // The latest reply was processed, but the one before it failed to classify and was never stored
        const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, new Map([["C1", cursor]]), {
          knownThreads: new Map([[parent, { latestAt: "2026-10-11T09:20:00.000Z", messageCount: 2 }]]),
          replyWindowStart: windowStart,
        });

        expect(mockConversationsReplies.mock.calls.map((c) => c[0].ts)).toEqual([parent]);
        expect(threads.map((t) => t.id)).toEqual([parent]);
      });

      it("reads a few active channels back to the window each poll, taking turns", async () => {
        const ids = ["CA", "CB", "CC", "CD", "CE", "CF", "CG", "CH"];
        mockConversationsList.mockResolvedValue({ channels: ids.map((id) => ({ id, name: id })), response_metadata: { next_cursor: "" } });
        history({});
        const cursors = new Map(ids.map((id) => [id, cursor]));
        const opts = () => ({ knownThreads: new Map([["1700000000.000000", { latestAt: "2023-11-14T22:13:20.000Z", messageCount: 1 }]]), replyWindowStart: windowStart });
        const wideChannels = () => ids.filter((id) => historyOldest(id).includes(String(windowStart.getTime() / 1000)));

        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, cursors, opts());
        expect(wideChannels()).toEqual(ids.slice(0, 5));
        expect(ids.every((id) => historyOldest(id).length === 1)).toBe(true); // every active channel still read

        mockConversationsHistory.mockClear();
        vi.setSystemTime(new Date("2026-10-13T12:00:30Z"));
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"), undefined, cursors, opts());
        expect(wideChannels()).toEqual(ids.slice(5));
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

    it("returns the posted message's ID and time", async () => {
      mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1700000099.000200" });

      expect(await adapter.replyToThread("1700000001.000100", "C001", "On it")).toEqual({
        messageId: "1700000099.000200",
        timestamp: new Date(1700000099000).toISOString(),
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

  describe("getUserName", () => {
    it("names users from the directory loaded at connect, without calling Slack", async () => {
      mockUsersList.mockResolvedValue({
        members: [{ id: "U0DANA0001", real_name: "Dana Reyes", profile: { display_name: "dana" } }],
        response_metadata: {},
      });
      await adapter.connect({ token: "xoxp-valid-token" });
      mockUsersList.mockClear();

      expect(adapter.getUserName("U0DANA0001")).toBe("dana");
      expect(adapter.getUserName("U0NOBODY01")).toBeNull();
      expect(mockUsersList).not.toHaveBeenCalled();
    });
  });

  describe("bot names", () => {
    beforeEach(async () => {
      mockBotsInfo.mockReset();
      await adapter.connect({ token: "xoxp-valid-token" });
      mockConversationsList.mockResolvedValue({ channels: [{ id: "C1", name: "fleet-ops" }], response_metadata: { next_cursor: "" } });
    });

    it("looks a bot up once when its messages don't carry its name", async () => {
      mockBotsInfo.mockResolvedValue({ ok: true, bot: { id: "B0RELAY001", name: "Relay" } });
      mockConversationsHistory.mockResolvedValue({
        messages: [
          { ts: "1791000000.000100", text: "tick", bot_id: "B0RELAY001" },
          { ts: "1791000000.000200", text: "tock", bot_id: "B0RELAY001" },
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

      expect(threads.flatMap((t) => t.messages).map((m) => m.userName)).toEqual(["Relay", "Relay"]);
      expect(mockBotsInfo).toHaveBeenCalledTimes(1);
    });

    it("doesn't take the name a webhook posts under, which the poster chooses", async () => {
      mockBotsInfo.mockResolvedValue({ ok: true, bot: { id: "B0HOOK0001", name: "CI [alerts] | ops\nbot" } });
      mockConversationsHistory.mockResolvedValue({
        messages: [{ ts: "1791000000.000100", text: "approved", bot_id: "B0HOOK0001", username: "Alex Rivera" }],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

      // bots.info's name, cleaned for prompts
      expect(threads[0].messages[0].userName).toBe("CI alerts ops bot");
    });

    it("falls back to the bot's ID, not 'unknown', when Slack has no such bot, and doesn't ask again", async () => {
      mockBotsInfo.mockRejectedValue(Object.assign(new Error("bot_not_found"), { data: { error: "bot_not_found" } }));
      mockConversationsHistory.mockResolvedValue({
        messages: [{ ts: "1791000000.000100", text: "tick", bot_id: "B0GONE0001" }],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));
      await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

      expect(threads[0].messages[0].userName).toBe("B0GONE0001");
      expect(mockBotsInfo).toHaveBeenCalledTimes(1);
    });

    it("tries a lookup again later after a passing failure", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        mockBotsInfo.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue({ ok: true, bot: { name: "Relay" } });
        mockConversationsHistory.mockResolvedValue({
          messages: [{ ts: "1791000000.000100", text: "tick", bot_id: "B0RELAY001" }],
          response_metadata: { next_cursor: "" },
        });
        await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);

        const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

        expect(threads[0].messages[0].userName).toBe("Relay");
      } finally {
        vi.useRealTimers();
      }
    });

    it("names bots in thread replies too", async () => {
      mockBotsInfo.mockResolvedValue({ ok: true, bot: { name: "Relay" } });
      mockConversationsHistory.mockResolvedValue({
        messages: [{ ts: "1791000000.000100", thread_ts: "1791000000.000100", reply_count: 1, latest_reply: "1791000000.000200", text: "parent", user: "U0OPERATOR1" }],
        response_metadata: { next_cursor: "" },
      });
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { ts: "1791000000.000100", thread_ts: "1791000000.000100", text: "parent", user: "U0OPERATOR1" },
          { ts: "1791000000.000200", thread_ts: "1791000000.000100", text: "reply", bot_id: "B0RELAY001" },
        ],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

      expect(threads[0].messages[1].userName).toBe("Relay");
    });

    it("renames bots stored as unknown", async () => {
      mockBotsInfo.mockResolvedValue({ ok: true, bot: { id: "B0RELAY001", name: "Relay" } });
      const upsertAgent = vi.fn();
      const renameAgent = vi.fn();
      const graph = {
        getAllAgents: () => [{ id: "B0RELAY001", name: "unknown", platform: "slack", platformUserId: "B0RELAY001", avatarUrl: "x" }],
        upsertAgent,
        renameAgent,
      } as any;

      expect(await adapter.backfillAgents(graph)).toBe(1);
      // Renamed without being marked seen: a name learned later isn't activity
      expect(renameAgent).toHaveBeenCalledWith("B0RELAY001", "Relay");
      expect(upsertAgent).not.toHaveBeenCalled();
    });

    it("renames an agent without marking it seen", async () => {
      const { Database } = await import("../../core/graph/db.js");
      const { ContextGraph } = await import("../../core/graph/index.js");
      const db = new Database(":memory:");
      try {
        const graph = new ContextGraph(db);
        graph.upsertAgent({ id: "B0RELAY001", name: "unknown", platform: "slack", platformUserId: "B0RELAY001" });
        db.db.prepare("UPDATE agents SET last_seen = '2026-10-01T00:00:00.000Z'").run();

        graph.renameAgent("B0RELAY001", "Relay");

        expect(graph.getAgentById("B0RELAY001")).toMatchObject({ name: "Relay", lastSeen: "2026-10-01T00:00:00.000Z" });
      } finally {
        db.close();
      }
    });

    it("uses the bot's ID when its name is nothing once cleaned", async () => {
      mockBotsInfo.mockResolvedValue({ ok: true, bot: { name: "[ | ]" } });
      mockConversationsHistory.mockResolvedValue({
        messages: [{ ts: "1791000000.000100", text: "tick", bot_id: "B0EMPTY001" }],
        response_metadata: { next_cursor: "" },
      });

      const threads = await adapter.readThreads(new Date("2026-10-10T00:00:00Z"));

      expect(threads[0].messages[0].userName).toBe("B0EMPTY001");
    });

    it("leaves people, named bots and other platforms' agents alone", async () => {
      const renameAgent = vi.fn();
      const graph = {
        getAllAgents: () => [
          { id: "U0DANA0001", name: "unknown", platform: "slack", platformUserId: "U0DANA0001", avatarUrl: null },
          { id: "B0NAMED001", name: "Atlas", platform: "slack", platformUserId: "B0NAMED001", avatarUrl: "x" },
          { id: "B0OTHER001", name: "unknown", platform: "other", platformUserId: "B0OTHER001", avatarUrl: "x" },
        ],
        upsertAgent: vi.fn(),
        renameAgent,
      } as any;

      await adapter.backfillAgents(graph);

      expect(mockBotsInfo).not.toHaveBeenCalled();
      expect(renameAgent).not.toHaveBeenCalled();
    });
  });

  describe("parseMention", () => {
    it("takes the user ID out of a mention, with or without a name", () => {
      expect(adapter.parseMention("<@U0DANA0001>")).toBe("U0DANA0001");
      expect(adapter.parseMention("<@U0DANA0001|dana>")).toBe("U0DANA0001");
      expect(adapter.parseMention("U0DANA0001")).toBeNull();
      expect(adapter.parseMention("<#C0FLEET001>")).toBeNull();
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
