// tests/grouping/asks.test.ts — who is waiting on whom

import { describe, it, expect } from "vitest";
import { findAsks, mentionsAsked, waitFor, type Ask } from "../../core/grouping/asks.js";
import type { Placement } from "../../core/grouping/cluster.js";
import type { LoadedMessage } from "../../core/grouping/load.js";

let n = 0;
function msg(sender: string, text: string, over: Partial<LoadedMessage> = {}): LoadedMessage {
  n++;
  return {
    key: `slack:C0OPS:${n}`, eventId: `e${n}`, threadId: "T1", channelId: "C0OPS", channelName: "ops", senderId: sender,
    senderName: sender, senderKind: "agent", at: new Date(Date.UTC(2026, 9, 19, 9, n)).toISOString(), text, status: "in_progress",
    targetedAtOperator: false, actionRequiredFrom: null, topLevel: false, ...over,
  };
}
const placed = (ms: LoadedMessage[]) => new Map<string, Placement>(ms.map((m) => [m.key, { cluster: "c1", via: null, viaReason: null, reasons: [], recognized: { kind: "work", about: null, aboutBy: null, mentions: [], lane: null, asks: false } }]));

describe("findAsks", () => {
  it("finds blocks from the classifier and asks from mentions, and closes them when the one asked posts in the case", () => {
    const ms = [
      msg("U0DANA", "hello"),
      msg("U0ATLAS", "Blocked on the schema", { status: "blocked_on_human", actionRequiredFrom: ["Dana"] }),
      msg("U0RELAY", "<@U0ATLAS> can you check the export? *Sent using* <@U0TOOL|Composer>"),
      msg("U0DANA", "Approved, go ahead"),
    ];
    const asks = findAsks(ms, placed(ms), new Map([["dana", "U0DANA"]]));
    expect(asks.map((a) => [a.strength, a.from, a.to, a.answeredAt !== null])).toEqual([
      ["blocks", "U0ATLAS", "U0DANA", true],
      ["asks", "U0RELAY", "U0ATLAS", false],
    ]);
  });
});

describe("findAsks across an actor's handles", () => {
  it("closes an ask when the agent answers on its other handle, and never makes an ask of itself", () => {
    const actorOf = new Map([["B0RELAY", "U0RELAY"]]);
    const ms = [
      msg("U0DANA", "<@B0RELAY> can you rerun the export?", { senderKind: "human" }),
      msg("B0RELAY", "Rerunning now."),
      msg("B0RELAY", "<@U0RELAY> please confirm the export finished"),
    ];
    const asks = findAsks(ms, placed(ms), new Map(), actorOf);
    expect(asks.map((a) => [a.from, a.to, a.answeredAt !== null])).toEqual([["U0DANA", "U0RELAY", true]]);
  });
});

describe("waitFor", () => {
  const ask = (from: string, to: string, strength: Ask["strength"] = "blocks"): Ask =>
    ({ strength, message: `${from}>${to}`, caseId: null, from, to, at: "2026-10-19T09:00:00.000Z", answeredAt: null, answeredBy: null });

  it("ranks who is waited on, finds deadlocks among blocks only, and follows each chain to its root", () => {
    const g = waitFor([ask("A", "B"), ask("B", "C"), ask("C", "B"), ask("D", "B"), ask("E", "A", "asks"), ask("A", "E", "asks")], "2026-10-01T00:00:00.000Z");
    expect(g.waitedOn[0]).toMatchObject({ actor: "B", blocking: 3 });
    expect(g.cycles).toEqual([["B", "C"]]);
    expect(g.rootBlockers.find((r) => r.actor === "D")!.path).toEqual(["D", "B", "C"]);
  });

  it("leaves out asks older than the window and asks already answered", () => {
    const old = { ...ask("A", "B"), at: "2026-09-01T00:00:00.000Z" };
    const answered = { ...ask("C", "B"), answeredAt: "2026-10-19T10:00:00.000Z" };
    expect(waitFor([old, answered], "2026-10-01T00:00:00.000Z").waitedOn).toEqual([]);
  });
});

describe("mentionsAsked", () => {
  it("counts a mention that opens the message or sits in an asking sentence, not one in passing", () => {
    expect(mentionsAsked("<@U0DANA> can you approve the export?")).toEqual(["U0DANA"]);
    expect(mentionsAsked("Shipped. As <@U0DANA> said, it's done.")).toEqual([]);
    expect(mentionsAsked("Shipped. Could <@U0RELAY> check the logs?")).toEqual(["U0RELAY"]);
  });
});
