// tests/graph/relink.test.ts — Re-link dry run: read-only replay of stored events through the resolver

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import {
  loadSubjectRules,
  openReadOnly,
  parseRelinkArgs,
  runRelink,
  subjectRuleCandidates,
  sweepStaleCopies,
  type Snapshot,
} from "../../core/graph/relink.js";

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

  const relinkTemps = () => readdirSync(tmpdir()).filter((f) => f.startsWith("workstream-relink-")).sort();

  it("opens a private copy read-only: writes are refused, and the copy is gone after", () => {
    const temps = relinkTemps();
    const copy = openReadOnly(dbPath);
    try {
      expect(copy.db.readonly).toBe(true);
      expect(copy.db.name).not.toBe(dbPath);
      expect(() => copy.db.prepare("UPDATE work_items SET title = 'x'").run()).toThrow();
      expect(() => copy.db.exec("CREATE TABLE scratch (x)")).toThrow();
    } finally {
      copy.close();
    }
    expect(relinkTemps()).toEqual(temps);
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
    expect(run.outDir).toBe(join(realpathSync(root), "eval-data", "relink"));
    expect(statSync(run.outDir).mode & 0o777).toBe(0o700);
    for (const f of run.files) expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("reads a log with no shared-memory file, and still creates nothing beside the database", () => {
    // A log left without its -shm (copied, or after a crash)
    const engine = new Database(dbPath);
    const other = join(dir, "other");
    mkdirSync(other);
    try {
      new ContextGraph(engine).upsertWorkItem({ id: "OPS-105", source: "extracted", title: "Only in the log" });
      copyFileSync(`${dbPath}-wal`, join(other, "workstream.db-wal"));
      copyFileSync(dbPath, join(other, "workstream.db"));
    } finally {
      engine.close();
    }
    const files = readdirSync(other).sort();
    expect(files).toEqual(["workstream.db", "workstream.db-wal"]);
    const before = hash(join(other, "workstream.db"));
    const { summary } = runRelink({ dbPath: join(other, "workstream.db"), root });
    expect(summary.before.items).toBe(9);
    expect(readdirSync(other).sort()).toEqual(files);
    expect(hash(join(other, "workstream.db"))).toBe(before);
  });

  it("copies again when the source changes during the copy, and refuses a copy that fails its check", () => {
    const attempts: number[] = [];
    const copy = openReadOnly(dbPath, {
      afterCopy: (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          const engine = new Database(dbPath);
          new ContextGraph(engine).upsertWorkItem({ id: "OPS-108", source: "extracted", title: "Written mid-copy" });
          engine.close();
        }
      },
    });
    try {
      expect(attempts).toEqual([1, 2]);
      expect(copy.db.prepare("SELECT id FROM work_items WHERE id = 'OPS-108'").get()).toEqual({ id: "OPS-108" });
    } finally {
      copy.close();
    }

    const temps = relinkTemps();
    const broken = join(dir, "data", "broken.db");
    writeFileSync(broken, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, 7)]));
    expect(() => openReadOnly(broken)).toThrow();
    expect(relinkTemps()).toEqual(temps);
  });

  it("cleans up on SIGINT, SIGTERM and exit while open, and stops listening once closed", () => {
    const counts = () => ["SIGINT", "SIGTERM", "exit"].map((e) => process.listenerCount(e));
    const before = counts();
    const copy = openReadOnly(dbPath);
    expect(counts()).toEqual(before.map((n) => n + 1));
    copy.close();
    expect(counts()).toEqual(before);
  });

  it("leaves no temp file behind when a report can't be written", () => {
    mkdirSync(join(root, "eval-data", "relink", "summary.json"), { recursive: true });
    writeFileSync(join(root, "eval-data", "relink", "summary.json", "keep"), "");
    expect(() => runRelink({ dbPath, root })).toThrow();
    expect(readdirSync(join(root, "eval-data", "relink")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to write through a symlinked eval-data or eval-data/relink", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "eval-data"));
    expect(() => runRelink({ dbPath, root })).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(join(root, "eval-data"));
    mkdirSync(join(root, "eval-data"));
    symlinkSync(elsewhere, join(root, "eval-data", "relink"));
    expect(() => runRelink({ dbPath, root })).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("reads ticket prefixes from the project's config like the engine, before the tracker's", () => {
    mkdirSync(join(root, "config"));
    copyFileSync(join(process.cwd(), "config", "default.yaml"), join(root, "config", "default.yaml"));
    writeFileSync(join(root, "config", "local.yaml"), "taskAdapter:\n  ticketPrefixes: [\"eng-\"]\n");
    runRelink({ dbPath, root });
    const report = JSON.parse(readFileSync(join(root, "eval-data", "relink", "summary.json"), "utf-8"));
    // The configured prefixes and the ones the tracker taught it, as the engine combines them
    expect(report.ticketPrefixes).toEqual(["ENG-", "OPS-"]);
    runRelink({ dbPath, root, prefixes: ["mkt-"] });
    expect(JSON.parse(readFileSync(join(root, "eval-data", "relink", "summary.json"), "utf-8")).ticketPrefixes).toEqual(["MKT-"]);

    rmSync(join(root, "config", "local.yaml"));
    runRelink({ dbPath, root });
    expect(JSON.parse(readFileSync(join(root, "eval-data", "relink", "summary.json"), "utf-8")).ticketPrefixes).toEqual(["OPS-"]);
  });

  it("only a thread's first, non-noise report keeps its replies from claiming it", () => {
    const db = new Database(dbPath);
    const graph = new ContextGraph(db);
    let minute = 0;
    const add = (threadId: string, messageId: string, agentId: string, text: string, status: "completed" | "in_progress" | "noise") => {
      graph.upsertThread({ id: threadId, channelId: "C0OPS", channelName: "ops", platform: "slack" });
      graph.insertEvent({ threadId, messageId, agentId, rawText: text, workItemId: null, status, confidence: 0.9, timestamp: new Date(Date.UTC(2026, 0, 7, 9, minute++)).toISOString() });
    };
    // A tick in the middle of a conversation
    add("t6", "m11", "U0RELAY", "Finished the nightly import", "completed");
    add("t6", "m12", "U0RELAY", "Nothing has changed since the last check", "in_progress");
    add("t6", "m13", "U0OPERATOR1", "Can you rerun it for yesterday?", "in_progress");
    // A tick classified as noise opening a thread
    add("t7", "m14", "U0RELAY", "Heartbeat", "noise");
    add("t7", "m15", "U0ATLAS", "Started OPS-107: the import retry", "in_progress");
    db.close();

    runRelink({ dbPath, root });
    const items = JSON.parse(readFileSync(join(root, "eval-data", "relink", "items.json"), "utf-8")) as {
      proposed: Array<{ keys: string[]; events: string[] }>;
    };
    const conversation = items.proposed.find((i) => i.keys.includes("thread:t6"));
    expect(conversation?.events).toHaveLength(3);
    expect(items.proposed.find((i) => i.keys.includes("ticket:OPS-107"))?.keys).toContain("thread:t7");
  });

  it("doesn't let a digest's thread be claimed by its replies", () => {
    const db = new Database(dbPath);
    const graph = new ContextGraph(db);
    const reply = (messageId: string, text: string, minute: number) =>
      graph.insertEvent({ threadId: "t4", messageId, agentId: "U0ATLAS", rawText: text, workItemId: "thread:t4", status: "in_progress", confidence: 0.9, timestamp: new Date(Date.UTC(2026, 0, 6, 9, minute)).toISOString() });
    reply("m9", "Started OPS-106: looking into the blocker", 0);
    reply("m10", "OPS-103: picking it up next", 1);
    db.close();

    runRelink({ dbPath, root });
    const items = JSON.parse(readFileSync(join(root, "eval-data", "relink", "items.json"), "utf-8")) as {
      proposed: Array<{ keys: string[]; events: string[] }>;
    };
    const started = items.proposed.find((i) => i.keys.includes("ticket:OPS-106"))!;
    const ops = items.proposed.find((i) => i.keys.includes("ticket:OPS-103"))!;
    expect(started.keys).toEqual(["ticket:OPS-106"]);
    expect(started.events).toHaveLength(1); // not the digest
    expect(ops).not.toBe(started);
    expect(items.proposed.some((i) => i.keys.includes("thread:t4"))).toBe(false);
  });

  it("reads a database the engine has open in place, read-only, and sees its unflushed writes", () => {
    const engine = new Database(dbPath); // holds the write-ahead log open, as a running engine does
    try {
      new ContextGraph(engine).upsertWorkItem({ id: "OPS-104", source: "extracted", title: "Late addition" });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      const dataFiles = readdirSync(join(dir, "data")).sort();
      const copy = openReadOnly(dbPath);
      try {
        expect(copy.db.readonly).toBe(true);
        expect(copy.db.prepare("SELECT id FROM work_items WHERE id = 'OPS-104'").get()).toEqual({ id: "OPS-104" });
        expect(() => copy.db.prepare("DELETE FROM work_items").run()).toThrow();
      } finally {
        copy.close();
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
    expect(summary.reports).toEqual({
      messages: 1,
      alreadyFlaggedDigest: 1,
      newlyDetected: 0,
      bySignal: { "digest-flag": 1 },
      bySignalStatus: { "digest-flag": { in_progress: 1 } },
    });
    const decisions = readFileSync(join(root, "eval-data", "relink", "decisions.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(decisions.every((d) => "report" in d && "status" in d)).toBe(true);
    // The ask with no key, the lone note and the operator's question: the model would be asked about each
    expect(summary.needsModel).toBe(3);
    expect(summary.ambiguous).toBe(0);
    expect(summary.notes.join(" ")).toMatch(/Rule 4/);
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

describe("relink options", () => {
  it("parses its flags, and refuses a missing value, a flag as a value, or an unknown flag", () => {
    expect(parseRelinkArgs(["--db", "x.db", "--prefixes", "OPS-, ENG-"])).toEqual({ db: "x.db", prefixes: ["OPS-", "ENG-"] });
    expect(() => parseRelinkArgs(["--db"])).toThrow(/needs a value/);
    expect(() => parseRelinkArgs(["--db", "--rules", "r.yaml"])).toThrow(/needs a value/);
    expect(() => parseRelinkArgs(["--out", "/tmp/x"])).toThrow(/Unexpected/);
    expect(() => parseRelinkArgs(["stray"])).toThrow(/Unexpected/);
  });

  it("reports a rules file it can't parse without echoing its content", () => {
    const dir = mkdtempSync(join(tmpdir(), "relink-rules-"));
    try {
      const path = join(dir, "rules.yaml");
      writeFileSync(path, "- pattern: [unclosed SECRET-LINE\n  sender: : :");
      let message = "";
      try {
        loadSubjectRules(path);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe("Subject rules: couldn't read the file as YAML");
      writeFileSync(path, "- pattern: '([a-'");
      expect(() => loadSubjectRules(path)).toThrow(/isn't a valid regular expression/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subjectRuleCandidates", () => {
  it("counts agents' lane tags only, not people's or unknown senders'", () => {
    const event = (agentId: string, senderKind: "agent" | "human" | "unknown") => ({
      id: agentId, threadId: "t", messageId: "m", workItemId: null, agentId, channelId: "C0OPS", platform: "slack",
      status: "in_progress" as const, text: "[intake] Contoso Ltd: sent the forms", timestamp: "", digest: false, senderKind,
    });
    const snapshot: Snapshot = {
      events: [event("U0RELAY", "agent"), event("U0OPERATOR1", "human"), event("U0SOMEONE", "unknown")],
      items: [], threads: [], junction: [], trackerPrefixes: [],
    };
    expect(subjectRuleCandidates(snapshot).map((c) => c.sender)).toEqual(["U0RELAY"]);
  });
});

describe("sweepStaleCopies", () => {
  it("removes copies whose run is gone, and leaves live runs' and other files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "relink-sweep-"));
    try {
      mkdirSync(join(dir, "workstream-relink-999999-abc")); // no such process
      writeFileSync(join(dir, "workstream-relink-999999-abc", "workstream.db"), "copy");
      mkdirSync(join(dir, `workstream-relink-${process.pid}-def`));
      mkdirSync(join(dir, "unrelated"));
      expect(sweepStaleCopies(dir)).toBe(1);
      expect(readdirSync(dir).sort()).toEqual([`workstream-relink-${process.pid}-def`, "unrelated"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
