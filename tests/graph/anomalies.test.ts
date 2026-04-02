import { describe, it, expect } from "vitest";
import { detectAnomalies, type AnomalyFlag, type FleetItemInput } from "../../core/graph/anomalies.js";

const NOW = new Date("2026-04-01T12:00:00Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

const defaultConfig = {
  staleThresholdHours: 4,
  silentAgentThresholdHours: 2,
};

describe("detectAnomalies", () => {
  it("returns empty array for healthy in-progress item", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toEqual([]);
  });

  it("detects stale item (no events for >threshold hours)", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(5),
      agentLastSeen: hoursAgo(5),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "stale" }),
    );
  });

  it("does NOT flag stale for completed items", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "completed",
      latestEventTimestamp: hoursAgo(10),
      agentLastSeen: hoursAgo(10),
      eventStatuses: ["completed"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies.find((a) => a.type === "stale")).toBeUndefined();
  });

  it("detects silent agent", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(3),
      eventStatuses: ["in_progress"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "silent_agent" }),
    );
  });

  it("detects status regression", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "blocked_on_human",
      latestEventTimestamp: hoursAgo(0.5),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress", "completed", "blocked_on_human"],
      title: "Fix login",
    };

    const anomalies = detectAnomalies(item, [], defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "status_regression" }),
    );
  });

  it("detects duplicate work items by title", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login bug",
    };

    const otherItems: FleetItemInput[] = [
      {
        workItemId: "AI-2",
        currentAtcStatus: "in_progress",
        latestEventTimestamp: hoursAgo(2),
        agentLastSeen: hoursAgo(1),
        eventStatuses: ["in_progress"],
        title: "Fix login bug",
      },
    ];

    const anomalies = detectAnomalies(item, otherItems, defaultConfig, NOW);
    expect(anomalies).toContainEqual(
      expect.objectContaining({ type: "duplicate_work" }),
    );
  });

  it("does not flag duplicate for different titles", () => {
    const item: FleetItemInput = {
      workItemId: "AI-1",
      currentAtcStatus: "in_progress",
      latestEventTimestamp: hoursAgo(1),
      agentLastSeen: hoursAgo(0.5),
      eventStatuses: ["in_progress"],
      title: "Fix login bug",
    };

    const otherItems: FleetItemInput[] = [
      {
        workItemId: "AI-2",
        currentAtcStatus: "in_progress",
        latestEventTimestamp: hoursAgo(2),
        agentLastSeen: hoursAgo(1),
        eventStatuses: ["in_progress"],
        title: "Add signup page",
      },
    ];

    const anomalies = detectAnomalies(item, otherItems, defaultConfig, NOW);
    expect(anomalies.find((a) => a.type === "duplicate_work")).toBeUndefined();
  });
});
