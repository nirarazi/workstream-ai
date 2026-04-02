import { createLogger } from "../logger.js";
import { SIDEKICK_SYSTEM_PROMPT } from "./system-prompt.js";
import { TOOL_SCHEMAS, executeTool } from "./tools.js";
import type { ContextGraph } from "../graph/index.js";

const log = createLogger("sidekick");

export interface SidekickConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxToolCalls: number;
}

export interface SidekickMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SidekickSource {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface SidekickResult {
  answer: string;
  sources: SidekickSource[];
}

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

export class Sidekick {
  private readonly config: SidekickConfig;
  private readonly graph: ContextGraph;
  private readonly isAnthropic: boolean;

  constructor(config: SidekickConfig, graph: ContextGraph) {
    this.config = config;
    this.graph = graph;
    this.isAnthropic = config.baseUrl.includes("anthropic");
  }

  async ask(question: string, history: SidekickMessage[]): Promise<SidekickResult> {
    const sources: SidekickSource[] = [];

    try {
      // Build initial messages from history + new question
      const messages: Array<{ role: string; content: unknown }> = [];
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: "user", content: question });

      let toolCallCount = 0;

      // Loop: send to LLM, execute tools, repeat until text response or limit
      while (toolCallCount < this.config.maxToolCalls) {
        const response = await this.callLLM(messages);

        // Check for tool use blocks
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        const textBlocks = response.content.filter((b) => b.type === "text");

        if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
          // Final text response
          const answer = textBlocks.map((b) => b.text ?? "").join("\n");
          return { answer: answer || "I couldn't find an answer.", sources };
        }

        // Execute each tool call
        // Add the assistant's response (with tool_use blocks) to messages
        messages.push({ role: "assistant", content: response.content });

        const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

        for (const block of toolUseBlocks) {
          toolCallCount++;
          const toolName = block.name!;
          const toolArgs = block.input ?? {};

          log.debug(`Executing tool: ${toolName}`, toolArgs);
          const result = executeTool(this.graph, toolName, toolArgs);

          sources.push({ tool: toolName, args: toolArgs, result });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: result,
          });
        }

        // Add tool results to messages
        messages.push({ role: "user", content: toolResults });
      }

      // Hit max tool calls — synthesize from what we have
      const sourceText = sources.map((s) => s.result).join("\n\n");
      return {
        answer: sourceText || "I ran out of query budget. Try a more specific question.",
        sources,
      };
    } catch (error) {
      log.error("Sidekick query failed", error);
      return {
        answer: "Sorry, I was unable to process your question. The LLM may be unavailable.",
        sources: [],
      };
    }
  }

  private async callLLM(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    if (this.isAnthropic) {
      return this.callAnthropic(messages);
    }
    return this.callOpenAI(messages);
  }

  private async callAnthropic(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 1024,
        system: SIDEKICK_SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        messages,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    return (await response.json()) as AnthropicResponse;
  }

  private async callOpenAI(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<AnthropicResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // Convert tool schemas to OpenAI format
    const tools = TOOL_SCHEMAS.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const openaiMessages = [
      { role: "system", content: SIDEKICK_SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: openaiMessages,
        tools,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = json.choices[0];
    const content: AnthropicContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    return {
      content,
      stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    };
  }
}
