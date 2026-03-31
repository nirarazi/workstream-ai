// tests/classifier/classifier.test.ts — Tests for classifier orchestration, prompt formatting, response parsing, error handling

import { describe, it, expect, vi } from "vitest";
import { Classifier } from "../../core/classifier/index.js";
import type { ModelProvider, ClassificationResult } from "../../core/classifier/providers/interface.js";
import { OpenAICompatibleProvider } from "../../core/classifier/providers/openai-compatible.js";

// --- Helpers ---

function mockProvider(result: ClassificationResult): ModelProvider {
  return {
    name: "mock",
    classify: vi.fn().mockResolvedValue(result),
  };
}

function failingProvider(error: Error): ModelProvider {
  return {
    name: "mock-failing",
    classify: vi.fn().mockRejectedValue(error),
  };
}

const SYSTEM_PROMPT = "You are a status classifier.";
const FEW_SHOT: Array<{ role: string; content: string }> = [
  { role: "user", content: "AI-382 is done" },
  { role: "assistant", content: '{"status":"completed","confidence":0.95,"reason":"done","workItemIds":["AI-382"]}' },
];

// --- Classifier orchestrator tests ---

describe("Classifier", () => {
  it("returns a valid classification for a completed task", async () => {
    const provider = mockProvider({
      status: "completed",
      confidence: 0.95,
      reason: "Agent said done",
      workItemIds: ["AI-382"],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("AI-382: PR merged and deployed.");

    expect(result.status).toBe("completed");
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toBe("Agent said done");
    expect(result.workItemIds).toEqual(["AI-382"]);
  });

  it("passes system prompt and few-shot examples to the provider", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "greeting",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    await classifier.classify("Hello world");

    expect(provider.classify).toHaveBeenCalledWith(
      "Hello world",
      SYSTEM_PROMPT,
      FEW_SHOT,
    );
  });

  it("clamps confidence to [0, 1] range", async () => {
    const provider = mockProvider({
      status: "in_progress",
      confidence: 1.5,
      reason: "over confident",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("working on it");
    expect(result.confidence).toBe(1);
  });

  it("clamps negative confidence to 0", async () => {
    const provider = mockProvider({
      status: "in_progress",
      confidence: -0.5,
      reason: "negative",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("working on it");
    expect(result.confidence).toBe(0);
  });

  it("maps invalid status to noise", async () => {
    const provider = mockProvider({
      status: "unknown_status",
      confidence: 0.8,
      reason: "model hallucinated",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("something weird");
    expect(result.status).toBe("noise");
  });

  it("returns default noise classification on provider error", async () => {
    const provider = failingProvider(new Error("API timeout"));
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("AI-100 is done");

    expect(result.status).toBe("noise");
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain("failed");
    expect(result.workItemIds).toEqual([]);
  });

  it("handles all valid status categories", async () => {
    const statuses = ["completed", "in_progress", "blocked_on_human", "needs_decision", "noise"] as const;

    for (const status of statuses) {
      const provider = mockProvider({
        status,
        confidence: 0.9,
        reason: `testing ${status}`,
        workItemIds: [],
      });
      const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);
      const result = await classifier.classify("test");
      expect(result.status).toBe(status);
    }
  });
});

// --- OpenAICompatibleProvider response parsing tests ---

describe("OpenAICompatibleProvider", () => {
  it("constructs with correct name and strips trailing slash from baseUrl", () => {
    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1/",
      model: "llama3",
    });
    expect(provider.name).toBe("test");
  });

  it("calls OpenAI-compatible endpoint and parses response", async () => {
    const mockResponse = {
      status: "completed",
      confidence: 0.95,
      reason: "Task done",
      workItemIds: ["AI-100"],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test-openai",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      apiKey: "test-key",
    });

    const result = await provider.classify("AI-100 is done", "System prompt", []);

    expect(result).toEqual(mockResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe("llama3");
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("System prompt");
    expect(body.messages[body.messages.length - 1].content).toBe("AI-100 is done");

    fetchSpy.mockRestore();
  });

  it("calls Anthropic endpoint when baseUrl contains 'anthropic'", async () => {
    const mockResponse = {
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs approval",
      workItemIds: ["IT-200"],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ text: JSON.stringify(mockResponse) }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test-anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test",
    });

    const result = await provider.classify("Need approval for IT-200", "System prompt", []);

    expect(result).toEqual(mockResponse);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.system).toBe("System prompt");
    expect(body.max_tokens).toBe(1024);

    fetchSpy.mockRestore();
  });

  it("includes few-shot examples in messages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"noise","confidence":0.5,"reason":"test","workItemIds":[]}' } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const fewShot = [
      { role: "user", content: "example input" },
      { role: "assistant", content: '{"status":"completed"}' },
    ];

    await provider.classify("test message", "sys", fewShot);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    // system + 2 few-shot + user = 4 messages
    expect(body.messages).toHaveLength(4);
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("example input");

    fetchSpy.mockRestore();
  });

  it("handles markdown-wrapped JSON response", async () => {
    const jsonContent = '{"status":"completed","confidence":0.9,"reason":"done","workItemIds":["AI-1"]}';
    const wrappedContent = "```json\n" + jsonContent + "\n```";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: wrappedContent } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("test", "sys", []);
    expect(result.status).toBe("completed");
    expect(result.workItemIds).toEqual(["AI-1"]);

    fetchSpy.mockRestore();
  });

  it("throws on API error (non-200 status)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    await expect(provider.classify("test", "sys", [])).rejects.toThrow("OpenAI API error 500");

    fetchSpy.mockRestore();
  });

  it("throws on malformed JSON response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "not json at all" } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    await expect(provider.classify("test", "sys", [])).rejects.toThrow();

    fetchSpy.mockRestore();
  });

  it("handles partial/missing fields in parsed JSON gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"completed"}' } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("test", "sys", []);
    expect(result.status).toBe("completed");
    expect(result.confidence).toBe(0);
    expect(result.reason).toBe("");
    expect(result.workItemIds).toEqual([]);

    fetchSpy.mockRestore();
  });
});
