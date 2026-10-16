// tests/decisions/gate.test.ts — classifier.mode "decisions": the decision model gates status and inbox membership

import { describe, it, expect, vi } from "vitest";
import { Classifier } from "../../core/classifier/index.js";
import type { ModelProvider } from "../../core/classifier/providers/interface.js";
import { classifyWithDecisions } from "../../core/decisions/classification.js";
import { DecisionGate, applyDecision, createDecisionGate, isOpenRouter } from "../../core/decisions/gate.js";
import type { DecisionProvider } from "../../core/decisions/interface.js";
import type { Config } from "../../core/config.js";
import type { Classification } from "../../core/types.js";
import { Database } from "../../core/graph/db.js";
import { UsageTracker } from "../../core/usage/tracker.js";
import { OpenAICompatibleProvider } from "../../core/classifier/providers/openai-compatible.js";

function stubDecisions(status: Record<string, number>, targeted: number, fail = false): DecisionProvider {
  const choice = Object.entries(status).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    name: "stub",
    decide: fail
      ? vi.fn().mockRejectedValue(new Error("decision API down"))
      : vi.fn().mockResolvedValue({
          answers: {
            status: { type: "choice", choice, confidence: 0.7, probabilities: status },
            targeted: { type: "yesno", probability: targeted },
          },
          usage: { inputTokens: 300, outputTokens: 0 },
          latencyMs: 5,
          model: "stub",
        }),
  } as DecisionProvider;
}

const LLM_RESULT: Classification = {
  status: "in_progress",
  entryType: "progress",
  confidence: 0.8,
  reason: "agent reports progress",
  workItemIds: ["OPS-101"],
  title: "Dispatch queue",
  targetedAtOperator: false,
  actionRequiredFrom: null,
  nextAction: "Unblock OPS-101",
};

describe("interrupt threshold", () => {
  const probs = { completed: 0.05, in_progress: 0.6, blocked_on_human: 0.25, needs_decision: 0.05, noise: 0.05 };

  it("uses plain argmax without a threshold", async () => {
    const r = await classifyWithDecisions(stubDecisions(probs, 0.9), { message: "x", operatorContext: "remit" });
    expect(r.status).toBe("in_progress");
  });

  it("surfaces the likeliest actionable status once P(blocked)+P(decision) reaches the threshold", async () => {
    const r = await classifyWithDecisions(stubDecisions(probs, 0.9), { message: "x", operatorContext: "remit" }, { interruptThreshold: 0.3 });
    expect(r.status).toBe("blocked_on_human");
    expect(r.targetedAtOperator).toBe(true);
  });
});

describe("applyDecision", () => {
  it("takes status and inbox membership from the decision and keeps the LLM's text", () => {
    const out = applyDecision(LLM_RESULT, {
      status: "blocked_on_human", confidence: 0.6, targetedAtOperator: true,
      statusProbabilities: {} as never, targetedProbability: 0.9, latencyMs: 1,
    });
    expect(out).toMatchObject({
      status: "blocked_on_human", entryType: "block", targetedAtOperator: true,
      title: "Dispatch queue", workItemIds: ["OPS-101"], nextAction: "Unblock OPS-101", actionRequiredFrom: [],
    });
    expect(out.reason).toContain("status set by decision model");
  });

  it("never lets the gate turn a notification bot's message into a block the LLM didn't see", () => {
    const noise = { ...LLM_RESULT, status: "noise" as const, entryType: "noise" as const };
    const block = { status: "blocked_on_human" as const, confidence: 0.4, targetedAtOperator: true, statusProbabilities: {} as never, targetedProbability: 0.9, latencyMs: 1 };
    expect(applyDecision(noise, block, "notification").status).toBe("noise");
    // Agents are unaffected, and the gate can still veto a notification block.
    expect(applyDecision(noise, block, "agent").status).toBe("blocked_on_human");
    const vetoed = applyDecision({ ...LLM_RESULT, status: "blocked_on_human", entryType: "block" }, { ...block, status: "noise", targetedAtOperator: false }, "notification");
    expect(vetoed.status).toBe("noise");
  });

  it("drops next action and actors when the decision says nothing is needed", () => {
    const out = applyDecision({ ...LLM_RESULT, status: "blocked_on_human", entryType: "block", actionRequiredFrom: ["U1"] }, {
      status: "noise", confidence: 0.9, targetedAtOperator: false,
      statusProbabilities: {} as never, targetedProbability: 0.1, latencyMs: 1,
    });
    expect(out).toMatchObject({ status: "noise", entryType: "noise", nextAction: null, actionRequiredFrom: null });
  });
});

describe("Classifier with a decision gate", () => {
  const llmProvider = (): ModelProvider => ({
    name: "mock",
    classify: vi.fn().mockResolvedValue({ status: "in_progress", confidence: 0.8, reason: "r", workItemIds: [], title: "T" }),
  });

  it("overrides the LLM's status with the gate's and reports usage", async () => {
    const onUsage = vi.fn();
    const c = new Classifier(llmProvider(), "sys", [], undefined, undefined, null, "Alex owns infra.");
    c.setDecisionGate(new DecisionGate(stubDecisions({ blocked_on_human: 0.8, in_progress: 0.2 }, 0.9), 0.5, onUsage));
    const r = await c.classify("Need S3 creds");
    expect(r.status).toBe("blocked_on_human");
    expect(r.title).toBe("T");
    expect(onUsage).toHaveBeenCalledWith("stub", 300, 0);
  });

  it("falls back to the LLM classification when the decision call fails", async () => {
    const c = new Classifier(llmProvider(), "sys", []);
    c.setDecisionGate(new DecisionGate(stubDecisions({}, 0, true), 0.5));
    const r = await c.classify("anything");
    expect(r.status).toBe("in_progress");
  });

  it("skips the decision call once the daily budget is spent", async () => {
    const decisions = stubDecisions({ blocked_on_human: 0.9, in_progress: 0.1 }, 0.9);
    const c = new Classifier(llmProvider(), "sys", []);
    c.setDecisionGate(new DecisionGate(decisions, 0.5, undefined, () => true));
    const r = await c.classify("Need S3 creds");
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(r.status).toBe("in_progress");
  });

  it("makes no decision call once new settings have replaced it", async () => {
    const decisions = stubDecisions({ blocked_on_human: 0.9, in_progress: 0.1 }, 0.9);
    const c = new Classifier(llmProvider(), "sys", []);
    c.setDecisionGate(new DecisionGate(decisions, 0.5, undefined, () => false, () => true));
    await c.classify("Need S3 creds");
    expect(decisions.decide).not.toHaveBeenCalled();
  });
});

describe("DecisionGate: timed-out decision calls count toward the budget", () => {
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const input = { message: "Need S3 creds", senderType: "agent" };

  it("counts an estimate for a call cut off at the timeout", async () => {
    const onUsage = vi.fn();
    const provider = { name: "stub", decide: vi.fn().mockRejectedValue(timeout()) } as DecisionProvider;
    await expect(new DecisionGate(provider, 0.5, onUsage).decide(input)).rejects.toThrow("timeout");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith("stub", expect.any(Number), expect.any(Number), true);
    expect(onUsage.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it("counts every attempt the provider reports timing out, even when a retry succeeds", async () => {
    const onUsage = vi.fn();
    const ok = stubDecisions({ in_progress: 1 }, 0.1);
    const provider: DecisionProvider = {
      name: "stub",
      decide: vi.fn(async (state, questions, options) => {
        options?.onTimedOutAttempt?.();
        options?.onTimedOutAttempt?.();
        return ok.decide(state, questions);
      }) as DecisionProvider["decide"],
    };
    await new DecisionGate(provider, 0.5, onUsage).decide(input);
    expect(onUsage.mock.calls.filter((c) => c[3] === true)).toHaveLength(2);
    expect(onUsage).toHaveBeenCalledWith("stub", 300, 0);
  });

  it("counts nothing for a call that failed before reaching the model", async () => {
    const onUsage = vi.fn();
    const provider = { name: "stub", decide: vi.fn().mockRejectedValue(new TypeError("fetch failed")) } as DecisionProvider;
    await expect(new DecisionGate(provider, 0.5, onUsage).decide(input)).rejects.toThrow("fetch failed");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("records the estimate as estimated in the usage table", async () => {
    const db = new Database(":memory:");
    const tracker = new UsageTracker({ name: "mock", classify: vi.fn() }, db, { dailyBudget: 5, inputCostPerMillion: 3, outputCostPerMillion: 15 });
    const gate = createDecisionGate({
      classifier: {
        mode: "decisions",
        provider: { baseUrl: "http://localhost:11434/v1", model: "llama" },
        decisions: { provider: "llm", interruptThreshold: 0.5, inputCostPerMillion: 1, outputCostPerMillion: 1 },
      },
    } as unknown as Config, tracker)!;
    vi.spyOn(OpenAICompatibleProvider.prototype, "completeWithUsage").mockRejectedValueOnce(timeout());

    await expect(gate.decide(input)).rejects.toThrow("timeout");

    const rows = db.db.prepare("SELECT caller, token_source, cost FROM llm_usage").all() as Array<{ caller: string; token_source: string; cost: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ caller: "decisions", token_source: "estimated" });
    expect(rows[0].cost).toBeGreaterThan(0);
    vi.restoreAllMocks();
    db.close();
  });
});

describe("isOpenRouter", () => {
  it("matches the host, not text anywhere in the URL", () => {
    expect(isOpenRouter("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouter("http://my-proxy.local/openrouter.ai/v1")).toBe(false);
    expect(isOpenRouter("https://openrouter.ai.evil.example/v1")).toBe(false);
    expect(isOpenRouter("not a url")).toBe(false);
  });
});

describe("createDecisionGate", () => {
  const base = { classifier: { provider: { baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: "k" }, confidenceThreshold: 0.6, mode: "llm" } } as unknown as Config;

  it("is off in llm mode", () => {
    expect(createDecisionGate(base)).toBeNull();
  });

  it("builds the configured provider in decisions mode", () => {
    const cfg = { classifier: { ...base.classifier, mode: "decisions", decisions: { provider: "openai", apiKey: "sk", interruptThreshold: 0.3 } } } as unknown as Config;
    expect(createDecisionGate(cfg)?.name).toBe("openai");
  });

  it("stays off (LLM only) when the provider can't be built", () => {
    const cfg = { classifier: { ...base.classifier, mode: "decisions", decisions: { provider: "openai", interruptThreshold: 0.3 } } } as unknown as Config;
    expect(createDecisionGate(cfg)).toBeNull();
  });
});
