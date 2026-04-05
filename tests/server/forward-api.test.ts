import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

describe("Forward API", () => {
  let app: Hono;
  let mockGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockAdapter: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockGraph = {
      getThreadById: vi.fn().mockReturnValue({
        id: "t-1", channelId: "C-1", channelName: "agent-orchestrator",
        platform: "slack", workItemId: "AI-100",
      }),
      getEventsForThread: vi.fn().mockReturnValue([
        { rawText: "Started working on auth", timestamp: "2026-04-01T10:00:00Z" },
        { rawText: "PR ready for review", timestamp: "2026-04-01T12:00:00Z" },
      ]),
      getSummary: vi.fn().mockReturnValue({
        summaryText: "• Auth middleware completed\n• PR #716 submitted",
      }),
      upsertThread: vi.fn().mockReturnValue({ id: "new-t" }),
      linkThread: vi.fn(),
    };

    mockAdapter = {
      postMessage: vi.fn().mockResolvedValue({ threadId: "new-ts" }),
      sendDirectMessage: vi.fn().mockResolvedValue({ channelId: "D001", threadId: "dm-ts" }),
      getThreadMessages: vi.fn().mockResolvedValue([
        { userName: "Byte", text: "Started working on auth" },
        { userName: "Pixel", text: "PR ready for review" },
      ]),
    };

    app = new Hono();

    app.post("/api/forward", async (c) => {
      const body = await c.req.json<{
        sourceThreadId: string;
        sourceChannelId: string;
        targetId: string;
        targetType: "user" | "channel";
        quoteMode?: "latest" | "full";
        includeSummary?: boolean;
        note?: string;
      }>();

      if (!body.sourceThreadId || !body.targetId || !body.targetType) {
        return c.json({ error: "Missing required fields" }, 400);
      }

      const sourceThread = mockGraph.getThreadById(body.sourceThreadId);
      if (!sourceThread) {
        return c.json({ error: "Source thread not found" }, 404);
      }

      // Build the forwarded message
      const parts: string[] = [];

      if (body.note) {
        parts.push(body.note);
      }

      const channelName = sourceThread.channelName || sourceThread.channelId;
      const quoteMode = body.quoteMode ?? "latest";

      if (quoteMode === "latest") {
        const events = mockGraph.getEventsForThread(body.sourceThreadId);
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          parts.push(`> Forwarded from #${channelName}:\n> "${lastEvent.rawText}"`);
        }
      } else {
        const messages = await mockAdapter.getThreadMessages(body.sourceThreadId, body.sourceChannelId);
        const quoted = messages
          .map((m: { userName: string; text: string }) => `> ${m.userName}: ${m.text}`)
          .join("\n");
        parts.push(`> Forwarded from #${channelName}:\n${quoted}`);
      }

      if (body.includeSummary) {
        const cached = mockGraph.getSummary(sourceThread.workItemId);
        if (cached) {
          parts.push(`Summary:\n${cached.summaryText}`);
        }
      }

      const composedMessage = parts.join("\n\n");

      let result: { threadId: string; channelId: string };
      if (body.targetType === "channel") {
        const r = await mockAdapter.postMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: body.targetId };
      } else {
        const r = await mockAdapter.sendDirectMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: r.channelId };
      }

      // Proactively link the new thread to the source work item
      if (sourceThread.workItemId) {
        mockGraph.upsertThread({
          id: result.threadId, channelId: result.channelId, channelName: "",
          platform: "slack", lastActivity: new Date().toISOString(), messageCount: 1,
        });
      }

      return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
    });
  });

  it("forwards latest message to a channel", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        quoteMode: "latest",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; threadId: string };
    expect(data.ok).toBe(true);

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("PR ready for review");
    expect(sentMessage).toContain("Forwarded from #agent-orchestrator");
  });

  it("forwards full thread to a user DM", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "U123",
        targetType: "user",
        quoteMode: "full",
      }),
    });
    expect(res.status).toBe(200);

    const sentMessage = mockAdapter.sendDirectMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("Byte: Started working on auth");
    expect(sentMessage).toContain("Pixel: PR ready for review");
  });

  it("includes summary when requested", async () => {
    const res = await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        includeSummary: true,
      }),
    });
    expect(res.status).toBe(200);

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain("Auth middleware completed");
  });

  it("prepends operator note", async () => {
    await app.request("/api/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceThreadId: "t-1",
        sourceChannelId: "C-1",
        targetId: "C-2",
        targetType: "channel",
        note: "FYI \u2014 needs your review",
      }),
    });

    const sentMessage = mockAdapter.postMessage.mock.calls[0][1] as string;
    expect(sentMessage.startsWith("FYI \u2014 needs your review")).toBe(true);
  });
});
