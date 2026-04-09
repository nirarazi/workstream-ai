// core/mcp/server.ts — MCP server exposing tools for agents to push status to workstream.ai

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import type { ContextGraph } from "../graph/index.js";
import type { StatusCategory } from "../types.js";

const VALID_STATUSES: StatusCategory[] = [
  "completed",
  "in_progress",
  "blocked_on_human",
  "needs_decision",
];

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

  // --- workstream_report_status ---
  server.tool(
    "workstream_report_status",
    {
      workItemId: z.string(),
      status: z.enum(["completed", "in_progress", "blocked_on_human", "needs_decision"]),
      message: z.string(),
    },
    async ({ workItemId, status, message }) => {
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: status as StatusCategory,
        currentConfidence: 1.0,
      });

      ensureMcpThread(workItemId);

      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId: randomUUID(),
        workItemId,
        status: status as StatusCategory,
        confidence: 1.0,
        reason: message,
        rawText: message,
        timestamp: new Date().toISOString(),
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
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: "needs_decision",
        currentConfidence: 1.0,
      });

      ensureMcpThread(workItemId);

      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId: randomUUID(),
        workItemId,
        status: "needs_decision",
        confidence: 1.0,
        reason: options ? JSON.stringify(options) : "",
        rawText: description,
        timestamp: new Date().toISOString(),
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
      graph.upsertWorkItem({
        id: workItemId,
        source: MCP_SOURCE,
        currentAtcStatus: "completed",
        currentConfidence: 1.0,
      });

      ensureMcpThread(workItemId);

      graph.insertEvent({
        threadId: MCP_THREAD_ID,
        messageId: randomUUID(),
        workItemId,
        status: "completed",
        confidence: 1.0,
        reason: summary,
        rawText: summary,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, workItemId }) }],
      };
    },
  );

  return server;
}
