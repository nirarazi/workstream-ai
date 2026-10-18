// tests/eval/linking-sample.test.ts — Linking eval: groupings, read-only source, and the sampler's strata

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { openReadOnly } from "../../core/graph/relink.js";
import {
  byMessage,
  currentEventGrouping,
  loadGroupings,
  loadMessageIndex,
  mergeTargets,
  messageKey,
  parseFlags,
  parseGoldClusters,
  parseGroupingNames,
  parseRelinkItems,
  type MessageIndex,
  type Observation,
} from "../../core/eval/linking-data.js";
import { pairKey } from "../../core/eval/linking-labels.js";
import type { Grouping } from "../../core/eval/linking-metrics.js";
import { buildQueue, candidatesByStratum, namesOf, refsOf } from "../../core/eval/linking-sample.js";

/** Message keys by message id, and event ids by "<thread>/<message>", filled by seed() */
type Ids = Record<string, string>;
const eventIds: Ids = {};

/**
 * A small fleet: Atlas and Relay (agents), Dana (the operator). Atlas rotates keys under OPS-101; an unrelated Relay
 * thread about the Northwind export was merged into it (an over-merge); a thread holds messages of two items (a split);
 * Atlas posts in #ops twice within a few hours under different items; Relay mentions OPS-101 from its own item; Dana
 * mentions Northwind in another channel.
 */
function seed(dbPath: string): Ids {
  const db = new Database(dbPath);
  const graph = new ContextGraph(db);
  for (const [id, name, isBot] of [["U0ATLAS", "Atlas", true], ["U0RELAY", "Relay", true], ["U0OPERATOR1", "Dana", false]] as const) {
    graph.upsertAgent({ id, name, platform: "slack", platformUserId: id, isBot });
  }
  const ids: Ids = {};
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 0, 5 + day, hour)).toISOString();
  const channelOf = new Map<string, string>();
  const thread = (id: string, channel: string, workItemId: string) => {
    graph.upsertWorkItem({ id: workItemId, source: workItemId.startsWith("thread:") ? "inferred" : "extracted", title: workItemId });
    graph.upsertThread({ id, channelId: `C0${channel.toUpperCase()}`, channelName: channel, platform: "slack", workItemId });
    channelOf.set(id, `C0${channel.toUpperCase()}`);
  };
  const event = (threadId: string, messageId: string, agentId: string, rawText: string, workItemId: string | null, timestamp: string) => {
    eventIds[`${threadId}/${messageId}`] = graph.insertEvent({ threadId, messageId, agentId, rawText, workItemId, status: "in_progress", confidence: 0.9, timestamp }).id;
    ids[messageId] = `slack:${channelOf.get(threadId)}:${messageId}`;
  };

  thread("t1", "ops", "OPS-101");
  event("t1", "m1", "U0ATLAS", "Started OPS-101: rotating the staging keys for Northwind", "OPS-101", at(0, 9));
  event("t1", "m2", "U0ATLAS", "Keys rotated on staging", null, at(0, 10));
  // The same message stored again under another thread of the channel (a second row): one message, its first row wins
  thread("t1r", "ops", "thread:t1r");
  event("t1r", "m1", "U0ATLAS", "Started OPS-101: rotating the staging keys for Northwind", "thread:t1r", at(0, 9));
  // A reply first seen on its own (a thread keyed by its own id), then in its thread t1: the thread's row represents it
  thread("m10", "ops", "thread:m10");
  event("m10", "m10", "U0ATLAS", "Rotation verified on staging", "thread:m10", at(0, 11));
  event("t1", "m10", "U0ATLAS", "Rotation verified on staging", null, at(0, 11));

  // Merged into OPS-101 the way older data was: the item points at OPS-101, its events weren't moved
  thread("t9", "deploy", "thread:t9");
  event("t9", "m9", "U0RELAY", "The Northwind invoice export is failing again", "thread:t9", at(10, 9));

  // One thread, two items
  thread("t3", "ops", "thread:t3");
  event("t3", "m3", "U0RELAY", "Looking at the flaky deploy check", "thread:t3", at(1, 9));
  graph.upsertWorkItem({ id: "OPS-102", source: "extracted", title: "Flaky deploy check" });
  event("t3", "m4", "U0RELAY", "Opened OPS-102 for the deploy check", "OPS-102", at(1, 10));

  thread("t4", "ops", "thread:t4");
  event("t4", "m5", "U0ATLAS", "Waiting for Dana to approve the staging cutover", "thread:t4", at(0, 14));

  thread("t5", "review", "thread:t5");
  event("t5", "m6", "U0RELAY", "Reviewing the OPS-101 changes now", "thread:t5", at(2, 9));

  thread("t6", "sales", "thread:t6");
  event("t6", "m7", "U0OPERATOR1", "The call with Northwind went fine", "thread:t6", at(3, 9));

  // A quoted line is someone else's words: no signal from it
  thread("t7", "misc", "thread:t7");
  event("t7", "m8", "U0OPERATOR1", "> Started OPS-101 per Atlas\nok", "thread:t7", at(4, 9));

  db.db.prepare("UPDATE work_items SET merged_into = 'OPS-101' WHERE id = 'thread:t9'").run();
  db.close();
  return ids;
}

describe("linking eval data and sampler", () => {
  let dir: string;
  let dbPath: string;
  let ids: Ids;
  let index: MessageIndex;
  let observations: Observation[];
  let current: Grouping;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "linking-sample-test-"));
    dbPath = join(dir, "workstream.db");
    ids = seed(dbPath);
    const source = openReadOnly(dbPath);
    try {
      index = loadMessageIndex(source.db);
      observations = index.observations;
      current = loadGroupings(["current"], dir, source.db, index).groupings.get("current")!;
    } finally {
      source.close();
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a private copy read-only: writes are refused, and the source is untouched", () => {
    const hash = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = hash();
    const source = openReadOnly(dbPath);
    try {
      expect(source.db.readonly).toBe(true);
      expect(source.db.name).not.toBe(dbPath);
      expect(() => source.db.prepare("UPDATE work_items SET title = 'x'").run()).toThrow();
      loadMessageIndex(source.db);
      currentEventGrouping(source.db);
    } finally {
      source.close();
    }
    expect(hash()).toBe(before);
  });

  it("reads one observation per message with the sender's own lines", () => {
    expect(observations).toHaveLength(10);
    const quoted = observations.find((o) => o.id === ids.m8)!;
    expect(quoted.text).toBe("ok");
    expect(observations.find((o) => o.id === ids.m1)).toMatchObject({ senderName: "Atlas", channelName: "ops", threadId: "t1" });
  });

  it("groups by each event's item, else its thread's, following merges", () => {
    expect(current.get(ids.m2)).toBe("OPS-101"); // no item of its own: its thread's
    expect(current.get(ids.m9)).toBe("OPS-101"); // thread:t9 was merged into OPS-101
    expect(current.get(ids.m4)).toBe("OPS-102");
  });

  it("reads newline runs and long messages in linear time", () => {
    const text = "Atlas\n".repeat(40000);
    const started = performance.now();
    namesOf(text, new Set());
    refsOf(text);
    // Within the length cap too: a quadratic pattern takes over a second for these 25
    for (let i = 0; i < 25; i++) namesOf("\n".repeat(40000) + " x", new Set());
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("finds tickets, PRs and capitalised names, but not technical terms, sentence openers or senders", () => {
    expect(refsOf("Done OPS-101, see https://github.com/acme/api/pull/7 and PR #12")).toEqual(["ticket:OPS-101", "pr:acme/api#7", "pr:#12"]);
    expect(refsOf("UTF-8, SHA-256, ISO-8601 and GPT-4 are not tickets; OPS-102 is")).toEqual(["ticket:OPS-102"]);
    expect(namesOf("Started the Northwind export. Atlas is on it, Dana approved", new Set(["dana"]))).toEqual(["Northwind"]);
  });

  it("draws each stratum's pairs from the signal it names", () => {
    const groupings = new Map([["current", current]]);
    const strata = candidatesByStratum(observations, groupings, 7, ["Atlas", "Relay", "Dana"]);
    const keys = (name: string) => new Set((strata.get(name) ?? []).map((c) => pairKey(c.a, c.b)));

    // Over-merge: the merged Northwind export sits in OPS-101 with Atlas's key rotation
    expect(strata.get("together:current")!.some((c) => c.a === ids.m9 || c.b === ids.m9)).toBe(true);
    for (const c of strata.get("together:current")!) expect(current.get(c.a)).toBe(current.get(c.b));

    // Splits: every pair is apart in the grouping
    for (const name of ["same-thread", "sender-channel-24h", "shared-ref", "shared-name"]) {
      expect(strata.get(name)!.length, name).toBeGreaterThan(0);
      for (const c of strata.get(name)!) expect(current.get(c.a), name).not.toBe(current.get(c.b));
    }
    expect([...keys("same-thread")]).toEqual([pairKey(ids.m3, ids.m4)]);
    expect(keys("sender-channel-24h").has(pairKey(ids.m2, ids.m5)) || keys("sender-channel-24h").has(pairKey(ids.m1, ids.m5))).toBe(true);
    expect(keys("shared-ref").has(pairKey(ids.m1, ids.m6))).toBe(true);
    // The quoted OPS-101 in m8 isn't a signal
    for (const c of strata.get("shared-ref")!) expect([c.a, c.b]).not.toContain(ids.m8);
    expect(keys("shared-name").has(pairKey(ids.m7, ids.m9)) || keys("shared-name").has(pairKey(ids.m1, ids.m7))).toBe(true);
  });

  it("samples from the union of groupings: a pair apart in either one counts", () => {
    // A proposal that keeps the deploy-check thread together: the same-thread pair still comes from the current split
    const relink: Grouping = new Map([...current].map(([id, item]) => [id, item === "OPS-102" ? "thread:t3" : item]));
    const strata = candidatesByStratum(observations, new Map([["current", current], ["relink", relink]]), 7);
    expect(strata.get("same-thread")!.map((c) => pairKey(c.a, c.b))).toContain(pairKey(ids.m3, ids.m4));
    expect(strata.has("together:relink")).toBe(true);
    expect(strata.get("together:relink")!.map((c) => pairKey(c.a, c.b))).toContain(pairKey(ids.m3, ids.m4));
  });

  it("builds a queue that skips labeled pairs, holds each pair once and caps each stratum", () => {
    const groupings = new Map([["current", current]]);
    const labeled = new Set([pairKey(ids.m3, ids.m4)]);
    const queue = buildQueue(observations, groupings, { perStratum: 1, seed: 7, labeled });
    const keys = queue.map((c) => pairKey(c.a, c.b));
    expect(keys).not.toContain(pairKey(ids.m3, ids.m4));
    expect(new Set(keys).size).toBe(keys.length);
    const perStratum = new Map<string, number>();
    for (const c of queue) perStratum.set(c.stratum, (perStratum.get(c.stratum) ?? 0) + 1);
    for (const n of perStratum.values()) expect(n).toBe(1);
    expect(perStratum.has("same-thread")).toBe(false);
    // Reproducible from its seed
    expect(buildQueue(observations, groupings, { perStratum: 1, seed: 7, labeled })).toEqual(queue);
  });

  it("reads the re-link proposal's items and refuses malformed ones", () => {
    const g = parseRelinkItems(JSON.stringify({ proposed: [{ id: "r1", events: ["e1", "e2"], keys: ["ticket:OPS-101"] }, { id: "r2", events: ["e3"] }], formerItemsNotCarried: [] }));
    expect([...g]).toEqual([["e1", "r1"], ["e2", "r1"], ["e3", "r2"]]);
    expect(() => parseRelinkItems(JSON.stringify({ proposed: [{ id: "r1", events: [1] }] }))).toThrow(/item 1/);
    expect(() => parseRelinkItems("{}")).toThrow(/proposed/);
  });

  it("loads the relink grouping from eval-data/relink, with a hint when it's missing", () => {
    const root = join(dir, "project");
    mkdirSync(join(root, "eval-data", "relink"), { recursive: true });
    const source = openReadOnly(dbPath);
    try {
      expect(() => loadGroupings(["relink"], root, source.db, index)).toThrow(/npm run relink/);
      // The proposal names events; scores use their messages. An event the database lacks is counted, not scored.
      writeFileSync(join(root, "eval-data", "relink", "items.json"), JSON.stringify({
        proposed: [{ id: "r1", events: [eventIds["t1/m1"], eventIds["t1/m2"]] }, { id: "r2", events: ["gone-event", eventIds["t1r/m1"]] }],
      }));
      const loaded = loadGroupings(["relink"], root, source.db, index);
      // m1's representative row is t1's: the proposal's r2 for its t1r row doesn't count
      expect(loaded.groupings.get("relink")!.get(ids.m1)).toBe("r1");
      expect(loaded.groupings.get("relink")!.get(ids.m2)).toBe("r1");
      expect(loaded.unmatched.get("relink")).toBe(1);
    } finally {
      source.close();
    }
  });

  it("keys messages by platform, channel and message id, and collapses a message's rows into one", () => {
    expect(messageKey("slack", "C0OPS", "1767603600.000100")).toBe("slack:C0OPS:1767603600.000100");
    expect(messageKey(null, null, "m1")).toBe("unknown::m1");
    const rows = [...index.keyOfEvent].filter(([, key]) => key === ids.m1);
    expect(rows.map(([id]) => id)).toEqual([eventIds["t1/m1"], eventIds["t1r/m1"]]);
    expect(observations.filter((o) => o.id === ids.m1)).toHaveLength(1);
    // Neither row is filed under the message's own id: the first stored represents it, for its thread and its item
    expect(index.rowOfMessage.get(ids.m1)).toBe(eventIds["t1/m1"]);
    expect(current.get(ids.m1)).toBe("OPS-101");
    expect(byMessage(new Map([[eventIds["t1r/m1"], "thread:t1r"]]), index).grouping.has(ids.m1)).toBe(false);
  });

  it("represents a message by its row in its own thread, not the row filed under its own id", () => {
    expect(index.rowOfMessage.get(ids.m10)).toBe(eventIds["t1/m10"]);
    const o = observations.find((x) => x.id === ids.m10)!;
    expect(o).toMatchObject({ threadId: "t1", eventId: eventIds["t1/m10"] });
    // The item comes from the same row: t1's (OPS-101), not the stand-alone thread:m10
    expect(current.get(ids.m10)).toBe("OPS-101");
  });

  it("follows merge chains, and resolves every member of a merge cycle to one item", () => {
    const chain = mergeTargets(new Map([["a", "b"], ["b", "c"], ["c", "d"]]));
    expect(["a", "b", "c", "d"].map(chain)).toEqual(["d", "d", "d", "d"]);
    // x → y → z → y: y and z form the cycle, and x leads into it
    const cycle = mergeTargets(new Map([["x", "y"], ["y", "z"], ["z", "y"], ["q", "q"]]));
    expect(["z", "y", "x"].map(cycle)).toEqual(["y", "y", "y"]);
    expect(cycle("q")).toBe("q");
    expect(cycle("free")).toBe("free");
  });

  it("parses gold clusters, options and grouping names strictly", () => {
    expect([...parseGoldClusters(JSON.stringify({ clusters: [["a", "b"], ["c"]] }))]).toEqual([["a", "0"], ["b", "0"], ["c", "1"]]);
    expect(() => parseGoldClusters(JSON.stringify([["a"], ["a"]]))).toThrow(/clusters 1 and 2/);
    expect(parseGroupingNames("current, relink,current")).toEqual(["current", "relink"]);
    expect(() => parseGroupingNames("live")).toThrow(/Unknown grouping/);
    expect(parseFlags(["--seed", "3"], ["seed", "db"] as const)).toEqual({ seed: "3" });
    expect(() => parseFlags(["--seed"], ["seed"] as const)).toThrow(/needs a value/);
    expect(() => parseFlags(["--path", "x"], ["seed"] as const)).toThrow(/Unexpected/);
  });
});
