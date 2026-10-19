// tests/grouping/load.test.ts — the messages the grouping reads from the database

import { describe, it, expect } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { actorOfHandle, loadGroupingMessages } from "../../core/grouping/load.js";

describe("loadGroupingMessages", () => {
  it("reads each message once, from the thread it replies in, with its sender's kind and its own lines", () => {
    const db = new Database(":memory:");
    const graph = new ContextGraph(db);
    graph.upsertAgent({ id: "U0ATLAS", name: "Atlas", platform: "slack", platformUserId: "U0ATLAS", isBot: true });
    const thread = (id: string) => graph.upsertThread({ id, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    thread("1700000001.000100");
    thread("1700000002.000100");
    const at = "2026-10-19T09:00:00.000Z";
    graph.insertEvent({ threadId: "1700000001.000100", messageId: "1700000001.000100", agentId: "U0ATLAS", status: "in_progress", confidence: 1, rawText: "Root", timestamp: at });
    // The reply, filed under its own id (channel history) and under its thread
    graph.insertEvent({ threadId: "1700000002.000100", messageId: "1700000002.000100", agentId: "U0ATLAS", status: "in_progress", confidence: 1, rawText: "&gt; Root\nReply", timestamp: at });
    graph.insertEvent({ threadId: "1700000001.000100", messageId: "1700000002.000100", agentId: "U0ATLAS", status: "in_progress", confidence: 1, rawText: "&gt; Root\nReply", timestamp: at });
    graph.insertEvent({ threadId: "1700000001.000100", messageId: "operator-action-1", status: "in_progress", confidence: 1, rawText: "Closed", timestamp: at });

    const messages = loadGroupingMessages(db.db);
    expect(messages.map((m) => [m.key, m.threadId, m.topLevel, m.senderKind, m.text])).toEqual([
      ["slack:C0OPS:1700000001.000100", "1700000001.000100", true, "agent", "Root"],
      ["slack:C0OPS:1700000002.000100", "1700000001.000100", false, "agent", "Reply"],
    ]);
    db.close();
  });
});

describe("actorOfHandle", () => {
  it("makes a handle named \"X - something\" the actor named X, and leaves other handles their own", () => {
    const actors = actorOfHandle(new Map([["U1", "Atlas"], ["U2", "Atlas - Release Agent"], ["U3", "Relay – Ops"], ["U4", "Dana"]]));
    expect(Object.fromEntries(actors)).toEqual({ U1: "U1", U2: "U1", U3: "U3", U4: "U4" });
  });
});
