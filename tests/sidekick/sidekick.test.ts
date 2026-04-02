import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { Sidekick } from "../../core/sidekick/index.js";

describe("Sidekick", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
      status: "in_progress", confidence: 0.9, rawText: "Working on login fix",
      timestamp: "2026-04-01T08:00:00Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("answers a question by calling tools and synthesizing a response", async () => {
    // Mock the LLM: first call returns a tool use, second call returns final answer
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First LLM call: returns tool_use
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "get_fleet_stats",
              input: {},
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      ),
    );

    // Second LLM call: returns text answer
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "You have 1 work item in progress (AI-100: Fix login).",
            },
          ],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      ),
    );

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 5,
    }, graph);

    const result = await sidekick.ask("How many items are in progress?", []);

    expect(result.answer).toContain("AI-100");
    expect(result.sources.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("handles LLM error gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("API timeout"),
    );

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 5,
    }, graph);

    const result = await sidekick.ask("What's happening?", []);

    expect(result.answer).toContain("unable");
    expect(result.sources).toEqual([]);

    fetchSpy.mockRestore();
  });

  it("respects maxToolCalls limit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Return tool_use every time to test the limit
    for (let i = 0; i < 3; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [{ type: "tool_use", id: `tu_${i}`, name: "get_fleet_stats", input: {} }],
            stop_reason: "tool_use",
          }),
          { status: 200 },
        ),
      );
    }

    const sidekick = new Sidekick({
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxToolCalls: 2,
    }, graph);

    const result = await sidekick.ask("What's happening?", []);

    // Should have stopped after 2 tool calls
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.answer.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });
});
