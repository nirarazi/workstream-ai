// core/mcp/server.ts — MCP server exposing tools for agents to push status to workstream.ai

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import type { ContextGraph } from "../graph/index.js";
import type { StatusCategory } from "../types.js";

const MCP_THREAD_ID = "mcp-direct";
const MCP_SOURCE = "mcp";

/**
 * Creates an MCP server wired to the given ContextGraph.
 * Exposes three tools: workstream_report_status, workstream_request_approval, workstream_complete.
 */
export function createMcpServer(graph: ContextGraph): McpServer {
  const server = new McpServer({ name: "workstream", version: "0.1.0" });

  // Ensure the shared MCP thread exists so event foreign keys are satisfied.
  function ensureMcpThread(workItemId: string): void {
    graph.upsertThread({
      id: MCP_THREAD_ID,
      channelId: "mcp",
      channelName: "MCP Direct",
      platform: "mcp",
      workItemId,
    });
  }

  /**
   * Records an agent's push as an observation (an agent_report) and returns its message id. Its author is whatever
   * agent called the tool: unverified, so it's recorded as unknown, never as a verified actor.
   */
  function recordReport(text: string, at: string): string {
    const messageId = randomUUID();
    graph.recordObservation({
      dedupeKey: `mcp-report:${messageId}`,
      kind: "agent_report",
      platform: "mcp",
      occurredAt: at,
      container: { kind: "mcp", id: "mcp" },
      messageId,
      author: { platform: "mcp", id: "unknown" },
      participants: [],
      senderKind: "agent",
      parts: { own: text, quoted: [], forwarded: [] },
      refs: { quotes: [], forwards: [] },
      externalRefs: [],
    });
    return messageId;
  }

  // --- workstream_report_status ---
  server.tool(
    "workstream_report_status",
    {
      workItemId: z.string(),
      status: z.enum(["completed", "in_progress", "blocked_on_human", "needs_decision"]),
      message: z.string(),
    },
    async ({ workItemId, status, message }) => {
      // An agent's push is a message: it sets the status time like any polled message does
      const now = new Date().toISOString();
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: status as StatusCategory,
        currentConfidence: 1.0,
        statusAt: now,
      });

      ensureMcpThread(workItemId);

      const messageId = recordReport(message, now);
      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId,
        workItemId,
        status: status as StatusCategory,
        confidence: 1.0,
        reason: message,
        rawText: message,
        timestamp: now,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, workItemId }) }],
      };
    },
  );

  // --- workstream_request_approval ---
  server.tool(
    "workstream_request_approval",
    {
      workItemId: z.string(),
      description: z.string(),
      options: z.array(z.string()).optional(),
    },
    async ({ workItemId, description, options }) => {
      // An agent's push is a message: it sets the status time like any polled message does
      const now = new Date().toISOString();
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: "needs_decision",
        currentConfidence: 1.0,
        statusAt: now,
      });

      ensureMcpThread(workItemId);

      const messageId = recordReport(description, now);
      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId,
        workItemId,
        status: "needs_decision",
        confidence: 1.0,
        reason: options ? JSON.stringify(options) : "",
        rawText: description,
        timestamp: now,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, workItemId }) }],
      };
    },
  );

  // --- workstream_complete ---
  server.tool(
    "workstream_complete",
    {
      workItemId: z.string(),
      summary: z.string(),
    },
    async ({ workItemId, summary }) => {
      // An agent's push is a message: it sets the status time like any polled message does
      const now = new Date().toISOString();
      // Completing a step (a sub-task folded into its parent) is progress on the case, not the case done
      const step = graph.isStepRef(workItemId);
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: step ? "in_progress" : "completed",
        currentConfidence: 1.0,
        statusAt: now,
      });

      ensureMcpThread(workItemId);

      const messageId = recordReport(summary, now);
      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId,
        workItemId,
        status: "completed",
        confidence: 1.0,
        reason: summary,
        rawText: summary,
        timestamp: now,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, workItemId }) }],
      };
    },
  );

  return server;
}
