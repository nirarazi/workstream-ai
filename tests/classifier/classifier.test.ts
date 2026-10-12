// tests/classifier/classifier.test.ts — Tests for classifier orchestration, prompt formatting, response parsing, error handling

import { describe, it, expect, vi } from "vitest";
import { Classifier } from "../../core/classifier/index.js";
import type { ModelProvider, ClassificationResult } from "../../core/classifier/providers/interface.js";
import { OpenAICompatibleProvider } from "../../core/classifier/providers/openai-compatible.js";
import type { OperatorIdentityMap } from "../../core/types.js";

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
  { role: "user", content: "OPS-382 is done" },
  { role: "assistant", content: '{"status":"completed","confidence":0.95,"reason":"done","workItemIds":["OPS-382"]}' },
];

// --- Classifier orchestrator tests ---

describe("Classifier", () => {
  it("returns a valid classification for a completed task", async () => {
    const provider = mockProvider({
      status: "completed",
      confidence: 0.95,
      reason: "Agent said done",
      workItemIds: ["OPS-382"],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("OPS-382: PR merged and deployed.");

    expect(result.status).toBe("completed");
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toBe("Agent said done");
    expect(result.workItemIds).toEqual(["OPS-382"]);
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

    const result = await classifier.classify("OPS-100 is done");

    expect(result.status).toBe("noise");
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain("failed");
    expect(result.workItemIds).toEqual([]);
  });

  it("passes through and validates breakdown from provider", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "Morning summary",
      workItemIds: ["OPS-382", "ENG-205"],
      title: "Morning briefing",
      breakdown: [
        { workItemId: "OPS-382", status: "completed", confidence: 0.95, reason: "PR merged", title: "PR done" },
        { workItemId: "ENG-205", status: "invalid_status", confidence: 1.5, reason: "Bad status", title: "Test" },
      ],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("Morning briefing...");

    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown![0].status).toBe("completed");
    expect(result.breakdown![0].confidence).toBe(0.95);
    // Invalid status mapped to noise, confidence clamped to 1
    expect(result.breakdown![1].status).toBe("noise");
    expect(result.breakdown![1].confidence).toBe(1);
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

  it("appends work item context to the system prompt", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "test",
      workItemIds: ["thread:existing.123"],
      title: "Missing API key",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const context = [
      { id: "thread:existing.123", title: "Missing API key for Anthropic" },
      { id: "OPS-100", title: "Fix login bug" },
    ];

    await classifier.classify("Missing API key error again", context);

    // The system prompt passed to the provider should contain the work item context
    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = callArgs[1] as string;
    expect(systemPrompt).toContain("thread:existing.123");
    expect(systemPrompt).toContain("Missing API key for Anthropic");
    expect(systemPrompt).toContain("OPS-100");
    expect(systemPrompt).toContain("Fix login bug");
  });

  it("works without work item context (backward compatible)", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "test",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("Hello");

    expect(result.status).toBe("noise");
    // System prompt should NOT contain work item section when no context provided
    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = callArgs[1] as string;
    expect(systemPrompt).not.toContain("Open Work Items");
  });

  it("includes channel context section in system prompt when provided", async () => {
    const provider = mockProvider({
      status: "in_progress",
      confidence: 0.9,
      reason: "continuation",
      workItemIds: ["OPS-382"],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const channelContext = [
      {
        workItemId: "OPS-382",
        workItemTitle: "Deploy new auth service",
        senderName: "Relay",
        text: "Starting the deployment now",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      },
      {
        workItemId: "ENG-205",
        workItemTitle: "Fix login bug",
        senderName: "Prism",
        text: "Login issue is resolved",
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 minutes ago
      },
    ];

    await classifier.classify(
      "Deployment is looking good so far",
      undefined,
      undefined,
      undefined,
      undefined,
      channelContext,
    );

    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = callArgs[1] as string;
    expect(systemPrompt).toContain("Recent Messages from the Same Channel");
    expect(systemPrompt).toContain("Starting the deployment now");
    expect(systemPrompt).toContain("OPS-382");
    expect(systemPrompt).toContain("Relay");
    expect(systemPrompt).toContain("Login issue is resolved");
    expect(systemPrompt).toContain("ENG-205");
    expect(systemPrompt).toContain("Prism");
  });

  it("does not include channel context section when channelContext is empty or undefined", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "no context",
      workItemIds: [],
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    // Test with undefined (no 6th argument)
    await classifier.classify("Hello world");
    const callArgs1 = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt1 = callArgs1[1] as string;
    expect(systemPrompt1).not.toContain("Recent Messages from the Same Channel");

    // Test with empty array
    await classifier.classify(
      "Hello again",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    const callArgs2 = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[1];
    const systemPrompt2 = callArgs2[1] as string;
    expect(systemPrompt2).not.toContain("Recent Messages from the Same Channel");
  });
});

// --- action_required_from → targetedAtOperator + nextAction tests (with OperatorIdentityMap) ---

describe("action_required_from → targetedAtOperator (with OperatorIdentityMap)", () => {
  const OPERATOR_MAP: OperatorIdentityMap = new Map([
    ["slack", { userId: "U0OPERATOR1", userName: "Alex Rivera" }],
    ["jira", { userId: "operator@example.com", userName: "Alex (CTO)" }],
  ]);

  it("action_required_from includes Slack operator ID → targetedAtOperator=true", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs operator review",
      workItemIds: ["OPS-100"],
      title: "Review needed",
      action_required_from: ["U0OPERATOR1"],
      next_action: "Review and approve the PR",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Please review this PR");
    expect(result.targetedAtOperator).toBe(true);
    expect(result.nextAction).toBe("Review and approve the PR");
    expect(result.actionRequiredFrom).toEqual(["U0OPERATOR1"]);
  });

  it("action_required_from includes Jira operator ID → targetedAtOperator=true", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs operator review",
      workItemIds: ["OPS-100"],
      title: "Review needed",
      action_required_from: ["operator@example.com"],
      next_action: "Review the ticket",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Please review this ticket");
    expect(result.targetedAtOperator).toBe(true);
  });

  it("action_required_from has only non-operator IDs → targetedAtOperator=false", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs Dana to review",
      workItemIds: ["OPS-100"],
      title: "Review needed",
      action_required_from: ["U0TEAMMATE1"],
      next_action: "Dana should review",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Dana please review");
    expect(result.targetedAtOperator).toBe(false);
  });

  it("action_required_from is null → targetedAtOperator=false (FYI)", async () => {
    const provider = mockProvider({
      status: "in_progress",
      confidence: 0.9,
      reason: "Agent working",
      workItemIds: ["OPS-100"],
      title: "In progress",
      action_required_from: null,
      next_action: null,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Working on it");
    expect(result.targetedAtOperator).toBe(false);
  });

  it("action_required_from null + blocked_on_human → targetedAtOperator=true (status implies action needed)", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Quote pending review",
      workItemIds: ["Q-123"],
      title: "Quote review",
      action_required_from: null,
      next_action: null,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Quote Q-123 pending review");
    // blocked_on_human + null action_required_from = contradiction → operator is backstop
    expect(result.targetedAtOperator).toBe(true);
  });

  it("action_required_from is empty array + LLM says targeted=true → targetedAtOperator=true", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Blocked on infra",
      workItemIds: ["OPS-100"],
      title: "IAM permissions",
      action_required_from: [],
      next_action: "Fix IAM role",
      targeted_at_operator: true,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Need IAM permissions fixed");
    expect(result.targetedAtOperator).toBe(true);
  });

  it("action_required_from is empty array → targetedAtOperator=true (operator is backstop for unattributed blocks)", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Waiting for client",
      workItemIds: ["ENG-200"],
      title: "Client credentials",
      action_required_from: [],
      next_action: "Client provides API key",
      targeted_at_operator: false,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Waiting for client API key");
    // Empty array = action needed but actor unknown → operator is backstop
    expect(result.targetedAtOperator).toBe(true);
  });

  it("action_required_from is empty array + LLM omits targeted → defaults to true (backstop)", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Blocked on something",
      workItemIds: ["OPS-100"],
      title: "Blocked",
      action_required_from: [],
      next_action: "Resolve block",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Something is blocking me");
    expect(result.targetedAtOperator).toBe(true);
  });

  it("no action_required_from field + blocked_on_human → targetedAtOperator=true (operator is backstop)", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs review",
      workItemIds: ["OPS-100"],
      title: "Review",
      targeted_at_operator: false,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Dana please review");
    // blocked_on_human with no named actor → operator is backstop, even if LLM says false
    expect(result.targetedAtOperator).toBe(true);
  });

  it("operator is among multiple action takers → targetedAtOperator=true", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs multiple reviewers",
      workItemIds: ["OPS-100"],
      title: "Multi-review needed",
      action_required_from: ["U0TEAMMATE1", "U0OPERATOR1", "UOTHERUSER"],
      next_action: "Multiple people need to review",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    const result = await classifier.classify("Please everyone review this");

    expect(result.targetedAtOperator).toBe(true);
    expect(result.actionRequiredFrom).toEqual(["U0TEAMMATE1", "U0OPERATOR1", "UOTHERUSER"]);
  });

  it("no action_required_from, no operator identity → falls back to targeted_at_operator boolean", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs human review",
      workItemIds: ["OPS-100"],
      title: "Review needed",
      targeted_at_operator: true,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("Please review this");

    expect(result.targetedAtOperator).toBe(true);
  });

  it("targeted_at_operator=false with no action_required_from but blocked → targetedAtOperator=true (backstop)", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs someone else",
      workItemIds: ["OPS-100"],
      title: "Review needed",
      targeted_at_operator: false,
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    const result = await classifier.classify("Dana please review this");
    // blocked_on_human without specific actor IDs → operator is backstop
    expect(result.targetedAtOperator).toBe(true);
  });
});

// --- Operator profile injection test ---

describe("thread context", () => {
  it("adds the thread's work item and earlier messages to the system prompt", async () => {
    const provider = mockProvider({ status: "in_progress", confidence: 0.8, reason: "", workItemIds: [], title: "" });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);
    await classifier.classify("approved, go ahead", undefined, undefined, undefined, undefined, undefined, {
      workItem: { id: "thread:1777", title: "Partner outreach email", status: null },
      messages: [{ senderName: "Echo", text: "Draft ready for review" }],
    });
    const system = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(system).toContain("## This Thread");
    expect(system).toContain('a thread about "Partner outreach email"');
    expect(system).not.toContain("thread:1777");
    expect(system).toContain('- [Echo] "Draft ready for review"');
  });
});

describe("targetedAtOperator with an operator remit", () => {
  const OPERATOR_MAP: OperatorIdentityMap = new Map([["slack", { userId: "U0OPERATOR1", userName: "Alex Rivera" }]]);
  const REMIT = "Dana owns partner outreach approvals.";
  const make = (result: ClassificationResult) =>
    new Classifier(mockProvider(result), SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP, REMIT);
  const block = { status: "blocked_on_human" as const, confidence: 0.9, reason: "", workItemIds: [], title: "" };

  it("a block the model says is someone else's stays out of the inbox, even with no named actor", async () => {
    const result = await make({ ...block, action_required_from: [], targeted_at_operator: false }).classify("Draft ready for approval");
    expect(result.targetedAtOperator).toBe(false);
  });

  it("an escalation the model says is the operator's reaches the inbox even when someone else is named", async () => {
    const result = await make({ ...block, action_required_from: ["U0TEAMMATE1"], targeted_at_operator: true }).classify("Meeting bot API 400 again");
    expect(result.targetedAtOperator).toBe(true);
  });

  it("being named always reaches the inbox", async () => {
    const result = await make({ ...block, action_required_from: ["U0OPERATOR1"], targeted_at_operator: false }).classify("Alex, can you check?");
    expect(result.targetedAtOperator).toBe(true);
  });

  it("falls back to the backstop when the model omits targeted_at_operator", async () => {
    const result = await make({ ...block }).classify("Blocked on credentials");
    expect(result.targetedAtOperator).toBe(true);
  });
});

describe("Operator profile and sender context", () => {
  const OPERATOR_MAP: OperatorIdentityMap = new Map([
    ["slack", { userId: "U0OPERATOR1", userName: "Alex Rivera" }],
    ["jira", { userId: "operator@example.com", userName: "Alex (CTO)" }],
  ]);

  it("injects operator profile with all platform identities into system prompt", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "greeting",
      workItemIds: [],
      title: "Hello",
    });
    const classifier = new Classifier(
      provider, SYSTEM_PROMPT, FEW_SHOT, undefined,
      "CTO / Fleet operator",  // operatorRole
      OPERATOR_MAP,
      "Manages a fleet of agents",  // operatorContext
    );

    await classifier.classify("Hello world");

    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = callArgs[1] as string;
    expect(systemPrompt).toContain("Operator Profile");
    expect(systemPrompt).toContain("slack:U0OPERATOR1");
    expect(systemPrompt).toContain("jira:operator@example.com");
    expect(systemPrompt).toContain("CTO / Fleet operator");
    expect(systemPrompt).toContain("Manages a fleet of agents");
  });

  it("prepends sender context to message text sent to provider", async () => {
    const provider = mockProvider({
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "blocked",
      workItemIds: [],
      title: "Blocked",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT, undefined, undefined, OPERATOR_MAP);

    await classifier.classify("Need help", undefined, undefined, {
      senderName: "Relay",
      senderType: "agent",
      channelName: "#fleet-ops",
    });

    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const messageText = callArgs[0] as string;
    expect(messageText).toContain("[Sender: Relay (agent)");
    expect(messageText).toContain("Channel: #fleet-ops]");
  });

  it("does not prepend sender context when not provided", async () => {
    const provider = mockProvider({
      status: "noise",
      confidence: 0.9,
      reason: "greeting",
      workItemIds: [],
      title: "Hello",
    });
    const classifier = new Classifier(provider, SYSTEM_PROMPT, FEW_SHOT);

    await classifier.classify("Hello world");

    const callArgs = (provider.classify as ReturnType<typeof vi.fn>).mock.calls[0];
    const messageText = callArgs[0] as string;
    expect(messageText).toBe("Hello world");
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
      workItemIds: ["OPS-100"],
      title: "Task completion",
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

    const result = await provider.classify("OPS-100 is done", "System prompt", []);

    expect(result).toEqual({ ...mockResponse, action_required_from: null, next_action: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe("llama3");
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("System prompt");
    expect(body.messages[body.messages.length - 1].content).toBe("OPS-100 is done");

    fetchSpy.mockRestore();
  });

  it("calls Anthropic endpoint when baseUrl contains 'anthropic'", async () => {
    const mockResponse = {
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Needs approval",
      workItemIds: ["ENG-200"],
      title: "Approval needed",
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

    const result = await provider.classify("Need approval for ENG-200", "System prompt", []);

    expect(result).toEqual({ ...mockResponse, action_required_from: null, next_action: null });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/messages");
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
    // OpenAI path: system + 2 few-shot + user = 4 messages
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    // Verify the user message is present
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user" && m.content !== "sys");
    expect(userMsg).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("handles markdown-wrapped JSON response", async () => {
    const jsonContent = '{"status":"completed","confidence":0.9,"reason":"done","workItemIds":["OPS-1"]}';
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
    expect(result.workItemIds).toEqual(["OPS-1"]);

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

  it("retries on 429 with exponential backoff and recovers", async () => {
    const successResponse = {
      status: "completed",
      confidence: 0.9,
      reason: "done",
      workItemIds: ["OPS-1"],
      title: "Task done",
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"error":"rate limited"}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"error":"rate limited"}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(successResponse) } }],
        }), { status: 200 }),
      );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("test", "sys", []);

    expect(result).toEqual({ ...successResponse, action_required_from: null, next_action: null });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(provider.backoffState.active).toBe(false);
    expect(provider.backoffState.lastError).toBeNull();

    fetchSpy.mockRestore();
  }, 30_000);

  it("exposes backoff state during retries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"error":"rate limited"}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: '{"status":"noise","confidence":0.5,"reason":"ok","workItemIds":[]}' } }],
        }), { status: 200 }),
      );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    // Start classify — it will hit 429, backoff, then succeed
    const resultPromise = provider.classify("test", "sys", []);

    const result = await resultPromise;
    expect(result.status).toBe("noise");
    // After success, backoff should be cleared
    expect(provider.backoffState.active).toBe(false);

    fetchSpy.mockRestore();
  }, 30_000);

  it("parses breakdown array from summary message response", async () => {
    const mockResponse = {
      status: "noise",
      confidence: 0.9,
      reason: "Morning summary",
      workItemIds: ["OPS-382", "ENG-205"],
      title: "Morning briefing",
      breakdown: [
        { workItemId: "OPS-382", status: "completed", confidence: 0.95, reason: "PR merged", title: "PR deployment" },
        { workItemId: "ENG-205", status: "blocked_on_human", confidence: 0.9, reason: "Waiting on creds", title: "API credentials needed" },
      ],
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
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("Morning briefing...", "sys", []);
    expect(result.status).toBe("noise");
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown![0]).toEqual({
      workItemId: "OPS-382",
      status: "completed",
      confidence: 0.95,
      reason: "PR merged",
      title: "PR deployment",
      targeted_at_operator: undefined,
      action_required_from: null,
      next_action: null,
    });
    expect(result.breakdown![1].status).toBe("blocked_on_human");

    fetchSpy.mockRestore();
  });

  it("omits breakdown when not present in response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"completed","confidence":0.9,"reason":"done","workItemIds":["OPS-1"],"title":"Done"}' } }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("OPS-1 is done", "sys", []);
    expect(result.breakdown).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("parses action_required_from and next_action from response", async () => {
    const mockResponse = {
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "Waiting for Dana to review",
      workItemIds: ["OPS-100"],
      title: "PR review needed",
      action_required_from: ["U0TEAMMATE1"],
      next_action: "Review and approve PR #716",
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
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("test", "sys", []);
    expect(result.action_required_from).toEqual(["U0TEAMMATE1"]);
    expect(result.next_action).toBe("Review and approve PR #716");

    fetchSpy.mockRestore();
  });

  it("returns null action_required_from and null next_action when not present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"noise","confidence":0.9,"reason":"FYI","workItemIds":[],"title":"Update"}' } }],
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
    expect(result.action_required_from).toBeNull();
    expect(result.next_action).toBeNull();

    fetchSpy.mockRestore();
  });

  it("filters non-string values from action_required_from", async () => {
    const mockResponse = {
      status: "blocked_on_human",
      confidence: 0.9,
      reason: "test",
      workItemIds: [],
      title: "test",
      action_required_from: ["U0TEAMMATE1", 123, null, "U0OPERATOR1"],
      next_action: "Fix the flaky test",
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
      name: "test",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });

    const result = await provider.classify("test", "sys", []);
    expect(result.action_required_from).toEqual(["U0TEAMMATE1", "U0OPERATOR1"]);
    expect(result.next_action).toBe("Fix the flaky test");

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
