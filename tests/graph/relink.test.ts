// tests/graph/relink.test.ts — Re-link dry run: read-only replay of stored events through the resolver

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { openReadOnly, runRelink } from "../../core/graph/relink.js";

/** Text that must never reach a report */
const MARKER = "ZEBRA-QUOKKA-7";

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** A small fleet: Atlas and Relay (agents), Dana (the operator) and a tracker notification bot */
function seed(dbPath: string): void {
  const db = new Database(dbPath);
  const graph = new ContextGraph(db);
  const agent = (id: string, name: string, isBot: boolean) =>
    graph.upsertAgent({ id, name, platform: "slack", platformUserId: id, isBot });
  agent("U0ATLAS", "Atlas", true);
  agent("U0RELAY", "Relay", true);
  agent("U0OPERATOR1", "Dana", false);

  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 0, 5, 9, minute++)).toISOString();
  const thread = (id: string, workItemId: string | null = null) =>
    graph.upsertThread({ id, channelId: "C0OPS", channelName: "ops", platform: "slack", workItemId });
  const event = (threadId: string, messageId: string, agentId: string, rawText: string, workItemId: string | null, status: "completed" | "in_progress" | "blocked_on_human" | "needs_decision" | "noise" = "in_progress", digest = false) =>
    graph.insertEvent({ threadId, messageId, agentId, rawText, workItemId, status, confidence: 0.9, timestamp: at(), digest });

  // OPS-101: its ticket item, and a thread item that turns out to be about it
  graph.upsertWorkItem({ id: "OPS-101", source: "extracted", title: "Rotate the API keys" });
  graph.upsertEnrichment({ workItemId: "OPS-101", source: "tracker", data: {} });
  thread("t1", "OPS-101");
  event("t1", "m1", "U0ATLAS", `Started OPS-101: rotating the keys ${MARKER}`, "OPS-101");
  graph.upsertWorkItem({ id: "thread:t2", source: "inferred", title: "Key rotation follow-up" });
  thread("t2", "thread:t2");
  event("t2", "m2", "U0ATLAS", "Dana, which staging config should the new keys go to?", "thread:t2", "blocked_on_human");
  event("t2", "m3", "U0ATLAS", "This is OPS-101, the PR is up", "thread:t2");

  // A lone completion note: an item today, activity in the proposal
  graph.upsertWorkItem({ id: "thread:t3", source: "inferred", title: "Nightly cleanup" });
  thread("t3", "thread:t3");
  event("t3", "m4", "U0RELAY", "Finished the nightly cleanup", "thread:t3", "completed");

  // A digest naming three tickets: today it mints ENG-202 and OPS-103 with no events of their own
  graph.upsertWorkItem({ id: "thread:t4", source: "inferred", title: "Daily digest" });
  graph.upsertWorkItem({ id: "ENG-202", source: "extracted" });
  graph.upsertWorkItem({ id: "OPS-103", source: "extracted" });
  thread("t4", "thread:t4");
  for (const id of ["OPS-101", "ENG-202", "OPS-103"]) graph.linkThreadWorkItem("t4", id, "mentioned");
  event("t4", "m5", "U0RELAY", "Daily digest\n- OPS-101 in review\n- ENG-202 blocked\n- OPS-103 not started", "thread:t4", "in_progress", true);

  // The operator asks; Atlas answers in the thread
  graph.upsertWorkItem({ id: "thread:t5", source: "inferred", title: "Export timeout" });
  thread("t5", "thread:t5");
  event("t5", "m6", "U0OPERATOR1", "Can Atlas look at the export timeout?", "thread:t5", "needs_decision");
  event("t5", "m7", "U0ATLAS", "On it", "thread:t5");

  // An agent's MCP push
  graph.upsertWorkItem({ id: "deploy-payments", source: "mcp", title: "Deploy payments" });
  graph.upsertThread({ id: "mcp-direct", channelId: "mcp", channelName: "MCP Direct", platform: "mcp", workItemId: "deploy-payments" });
  event("mcp-direct", "m8", "U0ATLAS", "Deploying", "deploy-payments");
  db.close();
}

describe("relink dry run", () => {
  let dir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relink-test-"));
    root = join(dir, "project");
    dbPath = join(dir, "data", "workstream.db");
    mkdirSync(root);
    mkdirSync(join(dir, "data"));
    seed(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens the database read-only: writes are refused", () => {
    const db = openReadOnly(dbPath);
    try {
      expect(db.readonly).toBe(true);
      expect(() => db.prepare("UPDATE work_items SET title = 'x'").run()).toThrow();
      expect(() => db.exec("CREATE TABLE scratch (x)")).toThrow();
    } finally {
      db.close();
    }
  });

  it("refuses a database that doesn't exist, and doesn't create one", () => {
    const missing = join(dir, "data", "missing.db");
    expect(() => openReadOnly(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(() => runRelink({ dbPath: missing, root })).toThrow();
    expect(existsSync(join(root, "eval-data"))).toBe(false);
  });

  it("leaves the database unchanged and writes only under eval-data/relink/", () => {
    const before = hash(dbPath);
    const mtime = statSync(dbPath).mtimeMs;
    const dataFiles = readdirSync(join(dir, "data")).sort();
    const run = runRelink({ dbPath, root });

    expect(hash(dbPath)).toBe(before);
    expect(statSync(dbPath).mtimeMs).toBe(mtime);
    expect(readdirSync(join(dir, "data")).sort()).toEqual(dataFiles);
    const written = filesUnder(root).map((f) => relative(root, f)).sort();
    expect(written.every((f) => f.startsWith(join("eval-data", "relink") + "/"))).toBe(true);
    expect(written).toEqual(
      ["decisions.jsonl", "items.json", "merges.json", "subject-rule-candidates.json", "summary.json"].map((f) => join("eval-data", "relink", f)),
    );
    expect(run.outDir).toBe(join(root, "eval-data", "relink"));
  });

  it("reads a database the engine has open in place, read-only, and sees its unflushed writes", () => {
    const engine = new Database(dbPath); // holds the write-ahead log open, as a running engine does
    try {
      new ContextGraph(engine).upsertWorkItem({ id: "OPS-104", source: "extracted", title: "Late addition" });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      const dataFiles = readdirSync(join(dir, "data")).sort();
      const db = openReadOnly(dbPath);
      try {
        expect(db.readonly).toBe(true);
        expect(db.prepare("SELECT id FROM work_items WHERE id = 'OPS-104'").get()).toEqual({ id: "OPS-104" });
        expect(() => db.prepare("DELETE FROM work_items").run()).toThrow();
      } finally {
        db.close();
      }
      const { summary } = runRelink({ dbPath, root });
      expect(summary.before.items).toBe(9);
      expect(readdirSync(join(dir, "data")).sort()).toEqual(dataFiles);
    } finally {
      engine.close();
    }
  });

  it("stores ids and keys, never message text", () => {
    runRelink({ dbPath, root });
    for (const file of filesUnder(root)) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain(MARKER);
      expect(content).not.toContain("staging config");
      expect(content).not.toContain("nightly cleanup");
    }
  });

  it("collapses a ticket's items into one, keeps reports and lone notes out, and reports the metrics", () => {
    const { summary } = runRelink({ dbPath, root });
    const items = JSON.parse(readFileSync(join(root, "eval-data", "relink", "items.json"), "utf-8")) as {
      proposed: Array<{ id: string; kind: string; title: string; keys: string[]; events: string[]; collapses: Array<{ id: string }> }>;
      formerItemsNotCarried: string[];
    };

    // OPS-101's ticket item and the thread item about it are one item now
    const ops = items.proposed.find((i) => i.keys.includes("ticket:OPS-101"))!;
    expect(ops.keys).toEqual(expect.arrayContaining(["thread:t1", "thread:t2"]));
    expect(ops.events).toHaveLength(3);
    expect(ops.collapses.map((c) => c.id).sort()).toEqual(["OPS-101", "thread:t2"]);
    expect(ops.title).toBe("Rotate the API keys");

    // The operator's ask and the MCP push are items; the digest and the lone note aren't
    expect(items.proposed.map((i) => i.kind).sort()).toEqual(["mcp", "thread", "ticket"]);
    expect(items.formerItemsNotCarried.sort()).toEqual(["ENG-202", "OPS-103", "thread:t3", "thread:t4"]);

    expect(summary.before).toMatchObject({ items: 8, zeroEventItems: 2, singleMessageItems: 4 });
    expect(summary.after).toMatchObject({ items: 3, singleMessageItems: 1 });
    expect(summary.reports).toEqual({ messages: 1, alreadyFlaggedDigest: 1, newlyDetected: 0 });
    expect(summary.activityNotItem).toBe(1);
    expect(summary.promotions).toBe(1);
    expect(summary.merges).toBe(1);
    expect(summary.itemsPerTicket.before.max).toBe(2); // OPS-101's own item, and the digest's thread item
    expect(summary.itemsPerTicket.holdersAfter.max).toBe(1);
    expect(summary.outcomes).toMatchObject({ ref: 1, promoted: 1, report: 1, activity: 1, mcp: 1 });

    const merges = JSON.parse(readFileSync(join(root, "eval-data", "relink", "merges.json"), "utf-8"));
    expect(merges).toEqual([{ from: expect.any(String), into: ops.id, event: expect.any(String) }]);
  });
});
