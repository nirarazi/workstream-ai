import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { executeTool, TOOL_SCHEMAS } from "../../core/sidekick/tools.js";

describe("sidekick tools", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);

    graph.upsertAgent({ id: "a1", name: "Byte", platform: "slack", platformUserId: "U1" });
    graph.upsertWorkItem({ id: "AI-100", source: "jira", title: "Fix login", currentAtcStatus: "in_progress" });
    graph.upsertThread({ id: "t1", channelId: "C1", platform: "slack", workItemId: "AI-100" });
    graph.insertEvent({
      threadId: "t1", messageId: "m1", workItemId: "AI-100", agentId: "a1",
      status: "in_progress", confidence: 0.9, rawText: "Working on login",
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("exports tool schemas", () => {
    expect(TOOL_SCHEMAS).toBeInstanceOf(Array);
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(0);
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toContain("query_work_items");
    expect(names).toContain("query_agents");
    expect(names).toContain("query_events");
    expect(names).toContain("get_fleet_stats");
  });

  it("executes query_work_items tool", () => {
    const result = executeTool(graph, "query_work_items", { query: "AI-100" });
    expect(result).toContain("AI-100");
  });

  it("executes query_agents tool", () => {
    const result = executeTool(graph, "query_agents", { name: "Byte" });
    expect(result).toContain("Byte");
  });

  it("executes query_events tool", () => {
    const result = executeTool(graph, "query_events", { since_hours: 24 });
    expect(result).toContain("AI-100");
  });

  it("executes get_fleet_stats tool", () => {
    const result = executeTool(graph, "get_fleet_stats", {});
    expect(result).toContain("in_progress");
    expect(result).toContain("total");
  });

  it("returns error for unknown tool", () => {
    const result = executeTool(graph, "unknown_tool", {});
    expect(result).toContain("Unknown tool");
  });
});
