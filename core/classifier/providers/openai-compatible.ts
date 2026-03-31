// core/classifier/providers/openai-compatible.ts — Universal provider for OpenAI-compatible and Anthropic APIs

import { createLogger } from "../../logger.js";
import type { ClassificationResult, ModelProvider } from "./interface.js";

const log = createLogger("openai-compatible");

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
  }

  async classify(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<ClassificationResult> {
    try {
      const rawText = this.isAnthropic
        ? await this.callAnthropic(message, systemPrompt, fewShotExamples)
        : await this.callOpenAI(message, systemPrompt, fewShotExamples);

      return this.parseResponse(rawText);
    } catch (error) {
      log.error("Classification failed", error);
      throw error;
    }
  }

  private async callAnthropic(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const url = `${this.baseUrl}/v1/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const messages = [
      ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
      { role: "user" as const, content: message },
    ];

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    };

    log.debug("Calling Anthropic API", { url, model: this.model });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      content: Array<{ text: string }>;
    };
    return json.content[0].text;
  }

  private async callOpenAI(
    message: string,
    systemPrompt: string,
    fewShotExamples: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...fewShotExamples.map((ex) => ({ role: ex.role, content: ex.content })),
      { role: "user" as const, content: message },
    ];

    const body = {
      model: this.model,
      messages,
      temperature: 0,
    };

    log.debug("Calling OpenAI-compatible API", { url, model: this.model });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return json.choices[0].message.content;
  }

  private parseResponse(rawText: string): ClassificationResult {
    // Strip markdown code fences if present
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const status = typeof parsed.status === "string" ? parsed.status : "noise";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    const workItemIds = Array.isArray(parsed.workItemIds)
      ? (parsed.workItemIds.filter((id) => typeof id === "string") as string[])
      : [];

    return { status, confidence, reason, workItemIds };
  }
}
