// tests/observations/observations.test.ts — recording observations, linking events to them, and the backfill

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { backfillObservations } from "../../core/observations/backfill.js";
import { observeSlackMessage } from "../../core/adapters/messaging/slack/observe.js";
import { ulid } from "../../core/observations/ulid.js";
import type { MessagingAdapter } from "../../core/adapters/messaging/interface.js";
import type { Message } from "../../core/types.js";

const workspace = { teamId: "T0NORTHWND", url: "https://northwind.slack.com" };
/** Just enough adapter for the backfill */
const adapter = { name: "slack", observe: (m: Message) => observeSlackMessage(m, workspace) } as unknown as MessagingAdapter;

function message(id: string, over: Partial<Message> = {}): Message {
  return {
    id, threadId: "1700000000.000100", channelId: "C0OPS", channelName: "ops", userId: "U0ATLAS", userName: "Atlas",
    text: `message ${id}`, timestamp: "2023-11-14T22:15:00.000Z", platform: "slack", senderType: "agent", ...over,
  };
}

describe("ulid", () => {
  it("is 26 Crockford base32 characters, ordered by time", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("observations in the graph", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
    graph.upsertThread({ id: "1700000000.000100", channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
  });

  afterEach(() => db.close());

  it("records an observation once, and reads it back", () => {
    const draft = observeSlackMessage(message("1700000100.000200", { text: "&gt; ship it?\nShipped" }), workspace)!;
    const id = graph.recordObservation(draft);
    expect(graph.recordObservation(draft)).toBe(id);
    expect(graph.getObservation(id)).toEqual({ id, ...draft, refs: JSON.parse(JSON.stringify(draft.refs)) });
    expect(graph.getObservation(id)!.parts).toEqual({ own: "Shipped", quoted: [{ text: "ship it?" }], forwarded: [] });
  });

  it("links an event to the observation of its message, whichever is stored first", () => {
    const first = graph.recordObservation(observeSlackMessage(message("1700000100.000200"), workspace)!);
    const after = graph.insertEvent({ threadId: "1700000000.000100", messageId: "1700000100.000200", status: "in_progress", confidence: 0.9, timestamp: "t" });
    expect(graph.getObservationIdForEvent(after.id)).toBe(first);

    const before = graph.insertEvent({ threadId: "1700000000.000100", messageId: "1700000200.000300", status: "in_progress", confidence: 0.9, timestamp: "t" });
    expect(graph.getObservationIdForEvent(before.id)).toBeNull();
    const second = graph.recordObservation(observeSlackMessage(message("1700000200.000300"), workspace)!);
    expect(graph.getObservationIdForEvent(before.id)).toBe(second);
  });

  it("backfills observations for earlier events, once each, from the row in the thread a message replies in", () => {
    // The same reply filed under its own id as well as under its thread
    graph.upsertThread({ id: "1700000100.000200", channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId: null });
    const own = graph.insertEvent({ threadId: "1700000100.000200", messageId: "1700000100.000200", status: "noise", confidence: 0.9, rawText: "Deployed", timestamp: "2023-11-14T22:15:00.000Z" });
    const reply = graph.insertEvent({ threadId: "1700000000.000100", messageId: "1700000100.000200", status: "in_progress", confidence: 0.9, rawText: "Deployed", timestamp: "2023-11-14T22:15:00.000Z" });

    expect(backfillObservations(db, graph, adapter)).toBe(1);
    const id = graph.getObservationIdForEvent(reply.id)!;
    expect(graph.getObservationIdForEvent(own.id)).toBe(id);
    expect(graph.getObservation(id)!.refs.repliesTo).toBe("slack:T0NORTHWND/C0OPS/1700000000.000100");
    expect(backfillObservations(db, graph, adapter)).toBe(0);
  });
});
