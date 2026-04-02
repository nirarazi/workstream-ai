import type { ContextGraph } from "../graph/index.js";

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "query_work_items",
    description: "Search work items by ID or title. Returns matching work items with their current status.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — matches against work item ID or title" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_agents",
    description: "Look up an agent by name and get their current work items.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (case-insensitive partial match)" },
      },
      required: ["name"],
    },
  },
  {
    name: "query_events",
    description: "Get recent events (classified messages) from the fleet. Use to find out what happened in a time window.",
    input_schema: {
      type: "object",
      properties: {
        since_hours: { type: "number", description: "How many hours back to look (e.g. 8 for last 8 hours, 24 for last day)" },
        work_item_id: { type: "string", description: "Optional: filter events to a specific work item" },
      },
      required: ["since_hours"],
    },
  },
  {
    name: "get_fleet_stats",
    description: "Get aggregate statistics about the fleet: count of work items by status.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

export function executeTool(
  graph: ContextGraph,
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "query_work_items": {
      const query = args.query as string;
      const items = graph.searchWorkItems(query);
      if (items.length === 0) return `No work items found matching "${query}".`;
      return items
        .map((wi) =>
          `${wi.id}: "${wi.title}" — status: ${wi.currentAtcStatus ?? "unknown"}, assignee: ${wi.assignee ?? "unassigned"}, updated: ${wi.updatedAt}`,
        )
        .join("\n");
    }

    case "query_agents": {
      const name = args.name as string;
      const agent = graph.getAgentByName(name);
      if (!agent) return `No agent found matching "${name}".`;

      const workItems = graph.getWorkItemsByAgent(agent.id);
      const wiList = workItems
        .map((wi) => `  - ${wi.id}: "${wi.title}" (${wi.currentAtcStatus ?? "unknown"})`)
        .join("\n");

      return `Agent: ${agent.name} (${agent.platform})\nLast seen: ${agent.lastSeen}\nWork items:\n${wiList || "  (none)"}`;
    }

    case "query_events": {
      const sinceHours = args.since_hours as number;
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      let events = graph.getEventsSince(since);

      const workItemId = args.work_item_id as string | undefined;
      if (workItemId) {
        events = events.filter((e) => e.workItemId === workItemId);
      }

      if (events.length === 0) return `No events in the last ${sinceHours} hours.`;

      return events
        .map((e) =>
          `[${e.timestamp}] ${e.workItemId ?? "—"} (${e.status}): ${e.rawText.slice(0, 200)}`,
        )
        .join("\n");
    }

    case "get_fleet_stats": {
      const stats = graph.getFleetStats();
      return Object.entries(stats)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
