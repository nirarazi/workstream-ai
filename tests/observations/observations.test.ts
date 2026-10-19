// tests/observations/observations.test.ts — recording observations, linking events to them, and the backfill

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("observation refs", () => {
  let db: Database;
  let graph: ContextGraph;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new ContextGraph(db);
  });

  afterEach(() => db.close());

  it("stores replies and quotes as edges, findable from the other end before it's seen", () => {
    const root = "slack:T0NORTHWND/C0OPS/1700000000.000100";
    const quoting = graph.recordObservation(observeSlackMessage(message("1700000300.000400", {
      threadId: "1700000300.000400",
      text: "<https://northwind.slack.com/archives/C0OPS/p1700000000000100>",
    }), workspace)!);
    const reply = graph.recordObservation(observeSlackMessage(message("1700000100.000200"), workspace)!);
    // The root itself hasn't been seen
    expect(graph.getObservationsReferring(root)).toEqual([
      { id: reply, kind: "replies_to" },
      { id: quoting, kind: "quotes" },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(graph.getObservationsReferring(root, "quotes")).toEqual([{ id: quoting, kind: "quotes" }]);
  });

  it("walks a reply chain through the observations seen", () => {
    const a = graph.recordObservation(observeSlackMessage(message("1700000000.000100", { threadId: "1700000000.000100" }), workspace)!);
    const b = graph.recordObservation(observeSlackMessage(message("1700000100.000200"), workspace)!);
    expect(graph.getReplyChain(b)).toEqual([a]);
    expect(graph.getReplyChain(a)).toEqual([]);
  });
});

describe("the observation refs backfill", () => {
  it("adds edges for observations recorded before observation_refs existed, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-refs-"));
    try {
      const path = join(dir, "workstream.db");
      const first = new Database(path);
      const graph = new ContextGraph(first);
      const id = graph.recordObservation(observeSlackMessage(message("1700000100.000200"), workspace)!);
      // As a database from before the table: no edges, and the backfill not yet run
      first.db.exec("DELETE FROM observation_refs; DELETE FROM meta WHERE key = 'observation_refs_backfill'");
      first.close();

      const second = new Database(path);
      expect(new ContextGraph(second).getObservationsReferring("slack:T0NORTHWND/C0OPS/1700000000.000100")).toEqual([{ id, kind: "replies_to" }]);
      second.db.exec("DELETE FROM observation_refs");
      second.close();

      const third = new Database(path);
      expect((third.db.prepare("SELECT COUNT(*) AS n FROM observation_refs").get() as { n: number }).n).toBe(0);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
