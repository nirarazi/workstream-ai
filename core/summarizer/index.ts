import { createLogger } from "../logger.js";
import { SUMMARIZER_SYSTEM_PROMPT, buildSummarizationPrompt, TICKET_DESCRIPTION_SYSTEM_PROMPT, buildTicketDescriptionPrompt } from "./prompt.js";
import type { Event } from "../types.js";
import type { UsageTracker } from "../usage/tracker.js";

const log = createLogger("summarizer");

export interface SummarizerConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  usageTracker?: UsageTracker;
}

export class Summarizer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly isAnthropic: boolean;
  private readonly usageTracker: UsageTracker | undefined;

  constructor(config: SummarizerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.isAnthropic = this.baseUrl.includes("anthropic");
    this.usageTracker = config.usageTracker;
  }

  async summarize(events: Event[], workItemId: string): Promise<string> {
    if (events.length === 0) {
      return `No conversation history for ${workItemId}.`;
    }

    const userPrompt = buildSummarizationPrompt(events, workItemId);

    try {
      return await this.complete(userPrompt, SUMMARIZER_SYSTEM_PROMPT, "summarizer");
    } catch (error) {
      log.warn("Summarization failed, generating fallback", error);
      return this.fallbackSummary(events, workItemId);
    }
  }

  async generateTicketDescription(events: Event[], title: string): Promise<string> {
    if (events.length === 0) {
      return title;
    }

    const userPrompt = buildTicketDescriptionPrompt(events, title);

    try {
      return await this.complete(userPrompt, TICKET_DESCRIPTION_SYSTEM_PROMPT, "ticket-description");
    } catch (error) {
      log.warn("Ticket description generation failed, using fallback", error);
      return events
        .slice(-5)
        .map((e) => e.rawText)
        .filter(Boolean)
        .join("\n\n");
    }
  }

  private async complete(userPrompt: string, systemPrompt: string, usageLabel: string): Promise<string> {
    return this.isAnthropic
      ? this.callAnthropic(userPrompt, systemPrompt, usageLabel)
      : this.callOpenAI(userPrompt, systemPrompt, usageLabel);
  }

  private async callAnthropic(userPrompt: string, systemPrompt: string, usageLabel: string): Promise<string> {
    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    };
    const response = this.usageTracker
      ? await this.usageTracker.completionCall(url, fetchOptions, usageLabel)
      : await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { content: Array<{ text: string }> };
    return json.content[0].text;
  }

  private async callOpenAI(userPrompt: string, systemPrompt: string, usageLabel: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    };
    const response = this.usageTracker
      ? await this.usageTracker.completionCall(url, fetchOptions, usageLabel)
      : await fetch(url, fetchOptions);

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
