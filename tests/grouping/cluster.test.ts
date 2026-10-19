// tests/grouping/cluster.test.ts — the v2 grouping: recognizers and scored clustering

import { describe, it, expect } from "vitest";
import { cluster, type ClusterOptions } from "../../core/grouping/cluster.js";
import { recognize, recordKey, releaseKey, stripEmphasis, taggedSubject, type GroupingMessage } from "../../core/grouping/recognize.js";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";

const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"] });
const options: ClusterOptions = { extractTickets: (t) => extractor.extractWorkItemIds(t) };

let n = 0;
function msg(text: string, over: Partial<GroupingMessage> = {}): GroupingMessage {
  n++;
  const ts = `17000000${String(n).padStart(2, "0")}.000100`;
  return {
    key: `slack:C0OPS:${ts}`, threadId: ts, channelId: "C0OPS", senderId: "U0ATLAS", senderKind: "agent",
    at: new Date(Date.UTC(2026, 9, 19, 9, n)).toISOString(), text, topLevel: over.threadId === undefined, ...over,
  };
}

function groups(messages: GroupingMessage[], opts: Partial<ClusterOptions> = {}): string[][] {
  const placed = cluster(messages, { ...options, ...opts });
  const by = new Map<string, string[]>();
  for (const m of messages) {
    const c = placed.get(m.key)!.cluster;
    if (c) by.set(c, [...(by.get(c) ?? []), m.text.slice(0, 20)]);
  }
  return [...by.values()];
}

describe("recognizers", () => {
  it("reads the subject of a routine's tagged line, whatever the lane", () => {
    expect(taggedSubject("[drain] Northwind Traders (wholesale, Ohio): no reply yet")).toEqual({ lane: "drain", subject: "northwind traders" });
    expect(taggedSubject("*[heartbeat]* *Dana Lee* — still waiting")).toEqual({ lane: "heartbeat", subject: "dana lee" });
    expect(taggedSubject("[drain] still nothing to do")).toBeNull(); // not a name
    expect(taggedSubject("No tag here")).toBeNull();
  });

  it("finds ticket keys behind markdown emphasis, and keeps URLs whole", () => {
    expect(stripEmphasis("_OPS-101 nudge_ and *bold*")).toBe(" OPS-101 nudge  and  bold ");
    expect(stripEmphasis("https://forge.example/my_repo/pull/7")).toBe("https://forge.example/my_repo/pull/7");
    expect(recognize(msg(":wave: _OPS-101 nudge_ — still in progress"), options).about).toBe("ticket:OPS-101");
  });

  it("reads crafted long text in linear time", () => {
    const n = 40_000;
    const started = Date.now();
    stripEmphasis("a" + "_".repeat(n) + "a");
    taggedSubject("[ab] Northwind" + " ".repeat(n) + "x");
    taggedSubject("[ab]" + "_".repeat(n) + "x\ry");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("never sets aside an ask as telemetry, and marks a report that carries one, so it surfaces on its own", () => {
    expect(recognize(msg("TICK_DONE cases=3", { status: "blocked_on_human" }), options).kind).toBe("work");
    const digest = recognize(msg("Daily digest\n- OPS-1 done\n- OPS-2 blocked\n- OPS-3 open", { status: "needs_decision" }), options);
    expect(digest).toMatchObject({ kind: "report", asks: true });
  });

  it("reads a sweep's no-change post as telemetry, with or without a time first", () => {
    expect(recognize(msg("No change since 11:15 check. Inbox unchanged."), options).kind).toBe("telemetry");
    expect(recognize(msg("13:47 UTC = 9:47 AM EST. No changes since last sweep."), options).kind).toBe("telemetry");
    expect(recognize(msg("No change needed on OPS-1, merging now"), options).kind).toBe("work");
  });

  it("reads a bare signature as chatter, and drops it from a message's text", () => {
    expect(recognize(msg("*Sent using* <@U0TOOL|Composer>"), options).kind).toBe("chatter");
    expect(recognize(msg("OPS-101 is merged\n*Sent using* <@U0TOOL|Composer>"), options).about).toBe("ticket:OPS-101");
    expect(recognize(msg("TICK_DONE shadow=on cases=26 skipped=13 not_pending=1 (Q-1:Pending)"), options).kind).toBe("telemetry");
    expect(recognize(msg("Quiet cycle. All pending items unchanged."), options).kind).toBe("telemetry");
  });

  it("tells briefings, health checks and chatter from work", () => {
    expect(recognize(msg("*Mission status, Mon Oct 12, 07:15 UTC* • Atlas: blocked on review"), options).kind).toBe("report");
    expect(recognize(msg("_Daily tracker sync — Oct 12_ — 30 open tickets checked"), options).kind).toBe("report");
    expect(recognize(msg("All green ✓ • Gateway: running"), options).kind).toBe("telemetry");
    expect(recognize(msg("OK are we still alive?", { senderKind: "human" }), options).kind).toBe("chatter");
    expect(recognize(msg("Fixed. Root cause: the stale note.\nIt now replies HEARTBEAT_OK only on ticks."), options).kind).toBe("work");
    expect(taggedSubject("[drain] Five items: • Northwind …")).toBeNull();
  });

  it("keys a pipeline's release notes by version, never a person's message", () => {
    expect(releaseKey(":label: Tag `1.13.90-production` pushed from PR #896", "agent")).toBe("release:1.13.90");
    expect(releaseKey("Upgraded to 2.0.1 locally", "agent")).toBeNull();
    expect(releaseKey("Deploy 1.2.3 please", "human")).toBeNull();
  });

  it("tells telemetry and reports from work, and never reads the classifier's noise as not work", () => {
    expect(recognize(msg("TICK_DONE shadow=on cases=26"), options).kind).toBe("telemetry");
    expect(recognize(msg("Daily digest\n- OPS-1 done\n- OPS-2 blocked\n- OPS-3 open"), options).kind).toBe("report");
    expect(recognize(msg("you merge", { senderKind: "human", status: "noise" }), options).kind).toBe("work");
  });
});

describe("cluster", () => {
  it("puts messages about one key together across threads, and different keys apart", () => {
    const g = groups([msg("OPS-101: started the export"), msg("OPS-202: unrelated fix"), msg("OPS-101 deployed")]);
    expect(g).toEqual([["OPS-101: started the", "OPS-101 deployed"], ["OPS-202: unrelated f"]]);
  });

  it("keeps a routine's notes about different subjects apart, and joins one subject across lanes and days", () => {
    const g = groups([
      msg("[drain] Northwind Traders (Ohio): no reply"),
      msg("[drain] Contoso Ltd (Texas): sent a note"),
      msg("[heartbeat] Northwind Traders — still waiting", { at: "2026-10-21T09:00:00.000Z" }),
    ]);
    expect(g.map((x) => x.length).sort()).toEqual([1, 2]);
  });

  it("joins a reply to its thread, with a key first named there, but not one another case already holds", () => {
    const elsewhere = msg("OPS-303: separate bug, being fixed");
    const root = msg("OPS-101: can someone look at the export?", { senderKind: "human", senderId: "U0DANA" });
    const reply = msg("Looking now", { threadId: root.threadId });
    const spawned = msg("Opened OPS-102 for the follow-up", { threadId: root.threadId });
    const other = msg("OPS-303 is the same root cause, by the way", { threadId: root.threadId, senderId: "U0RELAY" });
    const placed = cluster([elsewhere, root, reply, spawned, other], options);
    expect(placed.get(reply.key)!.cluster).toBe(placed.get(root.key)!.cluster);
    expect(placed.get(spawned.key)!.cluster).toBe(placed.get(root.key)!.cluster);
    expect(placed.get(other.key)!.cluster).toBe(placed.get(elsewhere.key)!.cluster);
  });

  it("joins a person's quick follow-up and a top-level answer to them", () => {
    const ask = msg("Call Alex", { senderKind: "human", senderId: "U0DANA" });
    const nudge = msg("?", { senderKind: "human", senderId: "U0DANA" });
    const answer = msg("Calling Alex now.", { senderId: "U0RELAY" });
    const placed = cluster([ask, nudge, answer], options);
    expect(new Set([ask, nudge, answer].map((m) => placed.get(m.key)!.cluster)).size).toBe(1);
  });

  it("names a subject known from tagged lines when a message mentions it untagged", () => {
    const tagged = msg("[drain] Northwind Traders (Ohio): no reply");
    const again = msg("[drain] Northwind Traders (Ohio): still nothing");
    const untagged = msg("I took the overdue task: Northwind Traders, the January start", { senderId: "U0RELAY", channelId: "C0OTHER" });
    const placed = cluster([untagged, tagged, again], options);
    expect(placed.get(untagged.key)!.cluster).toBe(placed.get(tagged.key)!.cluster);
    // Tagged once only, a name isn't known yet: one stray tagged line can't add a subject
    const once = msg("[drain] Contoso Partners (Texas): sent", { at: "2026-10-20T09:00:00.000Z" });
    const naming = msg("Contoso Partners asked again", { senderId: "U0RELAY", channelId: "C0OTHER", at: "2026-10-20T09:30:00.000Z" });
    const lone = cluster([once, naming], options);
    expect(lone.get(naming.key)!.cluster).not.toBe(lone.get(once.key)!.cluster);
  });

  it("keys a tool's alert by the record it links to, so alerts about different records stay apart", () => {
    expect(recordKey("*QUOTE <https://crm.example/index.php?module=Quotes&amp;action=Detail&amp;record=66e3525b-e8a1>* new")).toBe("record:crm.example/index.php#66e3525b-e8a1");
    expect(recordKey("see https://docs.example/guide")).toBeNull();
    const g = groups([
      msg("*QUOTE <https://crm.example/q?record=aaaa1111>* New lead: pending review", { senderKind: "notification" }),
      msg("*QUOTE <https://crm.example/q?record=bbbb2222>* New lead: pending review", { senderKind: "notification" }),
      msg("*QUOTE <https://crm.example/q?record=aaaa1111>* Lead updated: documents in", { senderKind: "notification" }),
    ]);
    expect(g.map((x) => x.length).sort()).toEqual([1, 2]);
  });

  it("keeps a sender's templated notes about different keys apart", () => {
    const g = groups([msg("OPS-101 status: in progress, PR opened for review"), msg("OPS-102 status: in progress, PR opened for review")]);
    expect(g).toHaveLength(2);
  });

  it("places a message the operator tied to a case even when it reads as a report", () => {
    const a = msg("OPS-101: started");
    const digest = msg("Daily digest\n- OPS-1 done\n- OPS-2 blocked\n- OPS-3 open");
    const placed = cluster([a, digest], { ...options, constraints: [{ kind: "must_link", a: digest.key, b: a.key }] });
    expect(placed.get(digest.key)!.cluster).toBe(placed.get(a.key)!.cluster);
  });

  it("leaves reports and telemetry out, and obeys the operator's constraints", () => {
    const a = msg("OPS-101: started");
    const b = msg("OPS-101: halfway");
    const beat = msg("TICK_DONE cases=3");
    const placed = cluster([a, b, beat], { ...options, constraints: [{ kind: "cannot_link", a: a.key, b: b.key }, { kind: "not_an_item", a: beat.key, b: null }] });
    expect(placed.get(a.key)!.cluster).not.toBe(placed.get(b.key)!.cluster);
    expect(placed.get(beat.key)!.cluster).toBeNull();
    expect(placed.get(b.key)!.reasons).toContain("new");
  });

  it("is deterministic: the same messages give the same clusters in any input order", () => {
    const ms = [msg("OPS-1 started"), msg("OPS-2 started"), msg("OPS-1 done"), msg("thanks", { senderKind: "human", senderId: "U0DANA" })];
    const one = cluster(ms, options);
    const two = cluster([...ms].reverse(), options);
    expect([...one].map(([k, p]) => [k, p.cluster])).toEqual(ms.map((m) => [m.key, two.get(m.key)!.cluster]));
  });
});
