import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

describe("Thread Linking API", () => {
  let app: Hono;
  let mockGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockAdapter: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockGraph = {
      getWorkItemById: vi.fn().mockReturnValue({ id: "AI-100", source: "extracted", title: "Test" }),
      getThreadById: vi.fn().mockReturnValue({
        id: "t-1", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: null, lastActivity: "2026-04-01T10:00:00.000Z",
        messageCount: 1, messages: [], manuallyLinked: false,
      }),
      linkThread: vi.fn(),
      unlinkThread: vi.fn(),
      getUnlinkedThreads: vi.fn().mockReturnValue([
        {
          id: "t-2", channelId: "C-2", channelName: "dev",
          platform: "slack", workItemId: null, lastActivity: "2026-04-02T10:00:00.000Z",
          messageCount: 5, messages: [], manuallyLinked: false,
        },
      ]),
      upsertThread: vi.fn().mockReturnValue({
        id: "t-new", channelId: "C-1", channelName: "general",
        platform: "slack", workItemId: "AI-100", lastActivity: "2026-04-05T10:00:00.000Z",
        messageCount: 1, messages: [], manuallyLinked: true,
      }),
    };

    mockAdapter = {
      name: "slack",
      displayName: "Slack",
      parseThreadUrl: vi.fn().mockImplementation((url: string) => {
        const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
        if (!match) return null;
        const rawTs = match[2];
        return { threadId: rawTs.slice(0, 10) + "." + rawTs.slice(10), channelId: match[1] };
      }),
      getThreadMessages: vi.fn().mockResolvedValue([
        { id: "msg-1", threadId: "1711900000.000100", channelId: "C001",
          channelName: "general", userId: "U1", userName: "Byte",
          text: "Working on AI-100", timestamp: "2026-04-01T10:00:00.000Z", platform: "slack" },
      ]),
    };

    app = new Hono();

    // POST /api/work-item/:id/link-thread
    app.post("/api/work-item/:id/link-thread", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ threadId: string }>();
      if (!body.threadId) {
        return c.json({ error: "Missing threadId" }, 400);
      }
      mockGraph.linkThread(body.threadId, id);
      return c.json({ ok: true });
    });

    // POST /api/work-item/:id/unlink-thread
    app.post("/api/work-item/:id/unlink-thread", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ threadId: string }>();
      if (!body.threadId) {
        return c.json({ error: "Missing threadId" }, 400);
      }
      mockGraph.unlinkThread(body.threadId);
      return c.json({ ok: true });
    });

    // GET /api/threads/unlinked
    app.get("/api/threads/unlinked", (c) => {
      const limit = parseInt(c.req.query("limit") ?? "20", 10);
      const q = c.req.query("q") || undefined;
      const threads = mockGraph.getUnlinkedThreads(limit, q);
      return c.json({ threads });
    });

    // POST /api/work-item/:id/link-url
    app.post("/api/work-item/:id/link-url", async (c) => {
      const id = c.req.param("id");
      if (!mockGraph.getWorkItemById(id)) {
        return c.json({ error: "Work item not found" }, 404);
      }
      const body = await c.req.json<{ url: string }>();
      if (!body.url) {
        return c.json({ error: "Missing url" }, 400);
      }

      // Delegate URL parsing to adapter
      const parsed = mockAdapter.parseThreadUrl(body.url);
      if (!parsed) {
        return c.json({ error: "Unrecognized thread URL format" }, 400);
      }
      const { threadId: threadTs, channelId } = parsed;

      // Fetch thread if not in graph
      if (!mockGraph.getThreadById(threadTs)) {
        const messages = await mockAdapter.getThreadMessages(threadTs, channelId);
        mockGraph.upsertThread({
          id: threadTs, channelId, channelName: "",
          platform: "slack", lastActivity: messages[0]?.timestamp ?? new Date().toISOString(),
          messageCount: messages.length,
        });
      }

      mockGraph.linkThread(threadTs, id);
      return c.json({ ok: true, threadId: threadTs });
    });
  });

  it("POST /api/work-item/:id/link-thread links a thread", async () => {
    const res = await app.request("/api/work-item/AI-100/link-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockGraph.linkThread).toHaveBeenCalledWith("t-1", "AI-100");
  });

  it("POST /api/work-item/:id/link-thread returns 404 for unknown work item", async () => {
    mockGraph.getWorkItemById.mockReturnValue(null);
    const res = await app.request("/api/work-item/NOPE/link-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/work-item/:id/unlink-thread unlinks a thread", async () => {
    const res = await app.request("/api/work-item/AI-100/unlink-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockGraph.unlinkThread).toHaveBeenCalledWith("t-1");
  });

  it("GET /api/threads/unlinked returns unlinked threads", async () => {
    const res = await app.request("/api/threads/unlinked?limit=10");
    expect(res.status).toBe(200);
    const data = await res.json() as { threads: unknown[] };
    expect(data.threads).toHaveLength(1);
  });

  it("GET /api/threads/unlinked passes query param", async () => {
    await app.request("/api/threads/unlinked?limit=10&q=dev");
    expect(mockGraph.getUnlinkedThreads).toHaveBeenCalledWith(10, "dev");
  });

  it("POST /api/work-item/:id/link-url parses Slack URL and links", async () => {
    mockGraph.getThreadById.mockReturnValue(null); // thread not in graph yet
    const res = await app.request("/api/work-item/AI-100/link-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://team.slack.com/archives/C001/p1711900000000100" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; threadId: string };
    expect(data.threadId).toBe("1711900000.000100");
    expect(mockGraph.linkThread).toHaveBeenCalledWith("1711900000.000100", "AI-100");
  });

  it("POST /api/work-item/:id/link-url rejects invalid URLs", async () => {
    const res = await app.request("/api/work-item/AI-100/link-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://google.com" }),
    });
    expect(res.status).toBe(400);
  });
});
