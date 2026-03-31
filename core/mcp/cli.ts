// core/mcp/cli.ts — Entry point for running the ATC MCP server standalone
//
// Run with: npx tsx core/mcp/cli.ts
//
// Uses stdio transport (stdin/stdout for MCP protocol).
// All logging goes to stderr so stdout stays clean for the protocol.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "../graph/db.js";
import { ContextGraph } from "../graph/index.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  // Log to stderr — stdout is reserved for MCP protocol messages
  console.error("[atc-mcp] Starting ATC MCP server...");

  const dbPath = process.env.ATC_DB_PATH ?? "atc.db";
  const db = new Database(dbPath);
  const graph = new ContextGraph(db);

  console.error("[atc-mcp] Database opened:", dbPath);

  const server = createMcpServer(graph);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("[atc-mcp] MCP server connected via stdio transport");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.error("[atc-mcp] Shutting down...");
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error("[atc-mcp] Shutting down...");
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[atc-mcp] Fatal error:", err);
  process.exit(1);
});
