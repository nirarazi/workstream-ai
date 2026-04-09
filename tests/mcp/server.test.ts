// tests/mcp/server.test.ts — Tests for the workstream.ai MCP server tools

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { createMcpServer } from "../../core/mcp/server.js";

describe("MCP Server", () => {
  let db: Database;
  let graph: ContextGraph;
  let client: Client;

  beforeEach(async () => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    const server = createMcpServer(graph);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(() => {
    db.close();
  });

  describe("workstream_report_status", () => {
    it("creates a work item and event with reported status", async () => {
      const result = await client.callTool({
        name: "workstream_report_status",
        arguments: {
          workItemId: "AI-100",
          status: "in_progress",
          message: "Working on authentication module",
        },
      });

      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed).toEqual({ ok: true, workItemId: "AI-100" });

      // Verify work item was created
      const workItem = graph.getWorkItemById("AI-100");
      expect(workItem).not.toBeNull();
      expect(workItem!.source).toBe("mcp");
      expect(workItem!.currentAtcStatus).toBe("in_progress");
      expect(workItem!.currentConfidence).toBe(1.0);

      // Verify event was inserted
      const events = graph.getEventsForWorkItem("AI-100");
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("in_progress");
      expect(events[0].reason).toBe("Working on authentication module");
      expect(events[0].rawText).toBe("Working on authentication module");
      expect(events[0].confidence).toBe(1.0);
    });

    it("updates an existing work item status", async () => {
      // First report
      await client.callTool({
        name: "workstream_report_status",
        arguments: {
          workItemId: "AI-200",
          status: "in_progress",
          message: "Started work",
        },
      });

      // Second report — status change
      await client.callTool({
        name: "workstream_report_status",
        arguments: {
          workItemId: "AI-200",
          status: "blocked_on_human",
          message: "Need API keys",
        },
      });

      const workItem = graph.getWorkItemById("AI-200");
      expect(workItem!.currentAtcStatus).toBe("blocked_on_human");

      const events = graph.getEventsForWorkItem("AI-200");
      expect(events).toHaveLength(2);
      expect(events[0].status).toBe("in_progress");
      expect(events[1].status).toBe("blocked_on_human");
    });

    it("accepts all valid status values", async () => {
      const statuses = ["completed", "in_progress", "blocked_on_human", "needs_decision"] as const;

      for (const status of statuses) {
        const result = await client.callTool({
          name: "workstream_report_status",
          arguments: {
            workItemId: `ITEM-${status}`,
            status,
            message: `Testing ${status}`,
          },
        });

        const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(parsed.ok).toBe(true);

        const workItem = graph.getWorkItemById(`ITEM-${status}`);
        expect(workItem!.currentAtcStatus).toBe(status);
      }
    });
  });

  describe("workstream_request_approval", () => {
    it("creates a needs_decision work item with description and options", async () => {
      const result = await client.callTool({
        name: "workstream_request_approval",
        arguments: {
          workItemId: "AI-300",
          description: "Which database should we use?",
          options: ["PostgreSQL", "MySQL", "SQLite"],
        },
      });

      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed).toEqual({ ok: true, workItemId: "AI-300" });

      const workItem = graph.getWorkItemById("AI-300");
      expect(workItem).not.toBeNull();
      expect(workItem!.currentAtcStatus).toBe("needs_decision");

      const events = graph.getEventsForWorkItem("AI-300");
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("needs_decision");
      expect(events[0].rawText).toBe("Which database should we use?");
      expect(JSON.parse(events[0].reason)).toEqual(["PostgreSQL", "MySQL", "SQLite"]);
    });

    it("works without options", async () => {
      const result = await client.callTool({
        name: "workstream_request_approval",
        arguments: {
          workItemId: "AI-301",
          description: "Please approve the deployment",
        },
      });

      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.ok).toBe(true);

      const events = graph.getEventsForWorkItem("AI-301");
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe("");
      expect(events[0].rawText).toBe("Please approve the deployment");
    });
  });

  describe("workstream_complete", () => {
    it("marks a work item as completed with summary", async () => {
      // First create as in_progress
      await client.callTool({
        name: "workstream_report_status",
        arguments: {
          workItemId: "AI-400",
          status: "in_progress",
          message: "Working on it",
        },
      });

      // Then complete
      const result = await client.callTool({
        name: "workstream_complete",
        arguments: {
          workItemId: "AI-400",
          summary: "Authentication module deployed successfully",
        },
      });

      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed).toEqual({ ok: true, workItemId: "AI-400" });

      const workItem = graph.getWorkItemById("AI-400");
      expect(workItem!.currentAtcStatus).toBe("completed");

      const events = graph.getEventsForWorkItem("AI-400");
      expect(events).toHaveLength(2);
      expect(events[1].status).toBe("completed");
      expect(events[1].reason).toBe("Authentication module deployed successfully");
      expect(events[1].rawText).toBe("Authentication module deployed successfully");
    });

    it("can complete a work item that does not yet exist", async () => {
      const result = await client.callTool({
        name: "workstream_complete",
        arguments: {
          workItemId: "AI-500",
          summary: "Quick fix applied",
        },
      });

      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.ok).toBe(true);

      const workItem = graph.getWorkItemById("AI-500");
      expect(workItem).not.toBeNull();
      expect(workItem!.currentAtcStatus).toBe("completed");
    });
  });

  describe("tool listing", () => {
    it("lists all three tools", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("workstream_report_status");
      expect(names).toContain("workstream_request_approval");
      expect(names).toContain("workstream_complete");
    });
  });
});
