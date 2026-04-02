import { createLogger } from "../logger.js";
import { SUMMARIZER_SYSTEM_PROMPT, buildSummarizationPrompt } from "./prompt.js";
import type { Event } from "../types.js";

const log = createLogger("summarizer");

export interface SummarizerConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class Summarizer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;

  constructor(config: SummarizerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
  }

  async summarize(events: Event[], workItemId: string): Promise<string> {
    if (events.length === 0) {
      return `No conversation history for ${workItemId}.`;
    }

    const userPrompt = buildSummarizationPrompt(events, workItemId);

    try {
      const summary = this.isAnthropic
        ? await this.callAnthropic(userPrompt)
        : await this.callOpenAI(userPrompt);
      return summary;
    } catch (error) {
      log.warn("Summarization failed, generating fallback", error);
      return this.fallbackSummary(events, workItemId);
    }
  }

  private async callAnthropic(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: SUMMARIZER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { content: Array<{ text: string }> };
    return json.content[0].text;
  }

  private async callOpenAI(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0].message.content;
  }

  private fallbackSummary(events: Event[], workItemId: string): string {
    const latest = events[events.length - 1];
    const lines = [
      `- Work item ${workItemId}: ${events.length} message(s) in thread`,
      `- Current status: ${latest.status}`,
      `- Latest: ${latest.rawText.slice(0, 150)}${latest.rawText.length > 150 ? "..." : ""}`,
    ];
    return lines.join("\n");
  }
}
