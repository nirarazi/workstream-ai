import { describe, it, expect, vi } from "vitest";
import { Summarizer } from "../../core/summarizer/index.js";
import type { Event } from "../../core/types.js";

const sampleEvents: Event[] = [
  {
    id: "e1",
    threadId: "t1",
    messageId: "m1",
    workItemId: "AI-382",
    agentId: "a1",
    status: "in_progress",
    confidence: 0.9,
    reason: "Agent started work",
    rawText: "Starting work on AI-382. Will submit PR shortly.",
    timestamp: "2026-03-31T08:00:00Z",
    createdAt: "2026-03-31T08:00:00Z",
  },
  {
    id: "e2",
    threadId: "t1",
    messageId: "m2",
    workItemId: "AI-382",
    agentId: "a1",
    status: "blocked_on_human",
    confidence: 0.95,
    reason: "Agent needs approval",
    rawText: "PR #716 is ready for review. Need approval before merging.",
    timestamp: "2026-03-31T10:00:00Z",
    createdAt: "2026-03-31T10:00:00Z",
  },
];

describe("Summarizer", () => {
  it("generates a summary from events using the LLM", async () => {
    const summaryText = "- Agent started work on AI-382\n- PR #716 submitted, awaiting review\n- Currently blocked: needs human approval to merge";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ text: summaryText }],
        }),
        { status: 200 },
      ),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    const result = await summarizer.summarize(sampleEvents, "AI-382");

    expect(result).toContain("AI-382");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("returns a fallback summary when LLM call fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("API timeout"),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    const result = await summarizer.summarize(sampleEvents, "AI-382");

    expect(result).toContain("AI-382");
    expect(result.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("builds a prompt that includes event raw text and statuses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ text: "- Summary bullet" }],
        }),
        { status: 200 },
      ),
    );

    const summarizer = new Summarizer({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
    });

    await summarizer.summarize(sampleEvents, "AI-382");

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const userMessage = body.messages.find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toContain("AI-382");
    expect(userMessage.content).toContain("Starting work on AI-382");
    expect(userMessage.content).toContain("blocked_on_human");

    fetchSpy.mockRestore();
  });
});
