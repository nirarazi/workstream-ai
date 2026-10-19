// tests/eval/linking-labels.test.ts — Linking label file: round trip, format version, private files

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEY_FORMAT,
  LABELS_VERSION,
  emptyLabels,
  labelsPath,
  loadLabels,
  pairKey,
  parseLabels,
  saveLabels,
  setPairLabel,
  toggleMark,
  toggleNotWork,
  LabelSession,
} from "../../core/eval/linking-labels.js";
import { clean, quoted } from "../../core/eval/terminal.js";
import { prepareOutDir } from "../../core/graph/relink.js";

describe("linking labels", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "linking-labels-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts empty when there's no file", () => {
    expect(loadLabels(root)).toEqual({ version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: [], notWork: [], mixed: [] });
  });

  it("round-trips through a private file in a private directory", () => {
    const labels = emptyLabels();
    setPairLabel(labels, { a: "slack:C0OPS:m2", b: "slack:C0OPS:m1", verdict: "different", note: "Atlas's OPS-101 vs Relay's Northwind export", labeledAt: "2026-01-05T09:00:00.000Z", stratum: "together:current" });
    toggleNotWork(labels, "slack:C0OPS:m3", "2026-01-05T09:01:00.000Z");
    const path = saveLabels(root, labels);

    expect(path.endsWith(join("eval-data", "linking", "labels.json"))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "eval-data", "linking")).mode & 0o777).toBe(0o700);
    const loaded = loadLabels(root);
    expect(loaded).toEqual(labels);
    // Stored in canonical order
    expect(loaded.pairs[0]).toMatchObject({ a: "slack:C0OPS:m1", b: "slack:C0OPS:m2" });
    const file = JSON.parse(readFileSync(labelsPath(root), "utf-8"));
    expect(file.version).toBe(1);
    expect(file.keyFormat).toBe("<platform>:<channel id>:<message id>");
  });

  it("replaces an earlier verdict on the same pair, in either order", () => {
    const labels = emptyLabels();
    setPairLabel(labels, { a: "x", b: "y", verdict: "same", labeledAt: "t1" });
    setPairLabel(labels, { a: "y", b: "x", verdict: "different", labeledAt: "t2" });
    expect(labels.pairs).toEqual([{ a: "x", b: "y", verdict: "different", labeledAt: "t2" }]);
    expect(pairKey("x", "y")).toBe(pairKey("y", "x"));
  });

  it("toggles a not-work mark", () => {
    const labels = emptyLabels();
    expect(toggleNotWork(labels, "m1")).toBe(true);
    expect(labels.notWork.map((n) => n.message)).toEqual(["m1"]);
    expect(toggleNotWork(labels, "m1")).toBe(false);
    expect(labels.notWork).toEqual([]);
  });

  it("keeps a message's not-work and mixed marks exclusive", () => {
    const labels = emptyLabels();
    toggleNotWork(labels, "m1");
    expect(toggleMark(labels, "mixed", "m1")).toBe(true);
    expect(labels.notWork).toEqual([]);
    expect(labels.mixed.map((n) => n.message)).toEqual(["m1"]);
    expect(toggleNotWork(labels, "m1")).toBe(true);
    expect(labels.mixed).toEqual([]);
  });

  it("reads a file written before mixed marks existed as having none, and refuses a malformed one", () => {
    expect(parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [], notWork: [] })).mixed).toEqual([]);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [], notWork: [], mixed: [{ labeledAt: "t" }] }))).toThrow(/mixed label 1/);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [], notWork: [], mixed: {} }))).toThrow(/mixed list/);
  });

  it("refuses a newer format version instead of misreading it", () => {
    expect(() => parseLabels(JSON.stringify({ version: LABELS_VERSION + 1, pairs: [], notWork: [] }))).toThrow(/newer/);
  });

  it("refuses a file whose message keys are in another format", () => {
    expect(() => parseLabels(JSON.stringify({ version: 1, pairs: [], notWork: [] }))).toThrow(/key format/);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: "events.id", pairs: [], notWork: [] }))).toThrow(/key format/);
  });

  it("refuses a file with no version, or malformed entries", () => {
    expect(() => parseLabels(JSON.stringify({ pairs: [], notWork: [] }))).toThrow(/version/);
    expect(() => parseLabels(JSON.stringify({ version: 0, pairs: [], notWork: [] }))).toThrow(/unsupported/);
    expect(() => parseLabels("not json")).toThrow(/JSON/);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [{ a: "x", b: "y", verdict: "maybe", labeledAt: "t" }], notWork: [] }))).toThrow(/pair 1/);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [{ a: "x", b: "x", verdict: "same", labeledAt: "t" }], notWork: [] }))).toThrow(/pair 1/);
    expect(() => parseLabels(JSON.stringify({ version: 1, keyFormat: KEY_FORMAT, pairs: [], notWork: [{ labeledAt: "t" }] }))).toThrow(/not-work label 1/);
  });

  it("won't write through a symlinked eval-data directory", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "eval-data"));
    expect(() => saveLabels(root, emptyLabels())).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "linking"))).toBe(false);
  });

  it("keeps what another session saved meanwhile, and attaches a note to a not-work mark", () => {
    const first = new LabelSession(root);
    const second = new LabelSession(root);
    first.setPair({ a: "slack:C0OPS:m1", b: "slack:C0OPS:m2", verdict: "same", labeledAt: "t1" });
    second.setPair({ a: "slack:C0OPS:m3", b: "slack:C0OPS:m4", verdict: "different", labeledAt: "t2" });
    second.toggleNotWork("slack:C0OPS:m5", "heartbeat from Relay");
    first.toggleNotWork("slack:C0OPS:m6");
    first.toggleNotWork("slack:C0OPS:m6"); // cleared again

    const saved = loadLabels(root);
    expect(saved.pairs.map((p) => p.a).sort()).toEqual(["slack:C0OPS:m1", "slack:C0OPS:m3"]);
    expect(saved.notWork).toEqual([expect.objectContaining({ message: "slack:C0OPS:m5", note: "heartbeat from Relay" })]);
    expect(first.labels).toEqual(saved);
  });

  it("doesn't replay a saved label over a newer one another session saved since", () => {
    const a = new LabelSession(root);
    const b = new LabelSession(root);
    a.setPair({ a: "slack:C0OPS:m1", b: "slack:C0OPS:m2", verdict: "same", labeledAt: "2026-01-05T09:00:00.000Z" });
    b.setPair({ a: "slack:C0OPS:m1", b: "slack:C0OPS:m2", verdict: "different", labeledAt: "2026-01-05T09:01:00.000Z" });
    a.setPair({ a: "slack:C0OPS:m3", b: "slack:C0OPS:m4", verdict: "same", labeledAt: "2026-01-05T09:02:00.000Z" });
    const pair12 = loadLabels(root).pairs.find((p) => p.a === "slack:C0OPS:m1")!;
    expect(pair12.verdict).toBe("different");
    expect(loadLabels(root).pairs).toHaveLength(2);
  });

  it("never applies a change over a newer label for the same pair", () => {
    const a = new LabelSession(root);
    const b = new LabelSession(root);
    b.setPair({ a: "slack:C0OPS:m5", b: "slack:C0OPS:m6", verdict: "different", labeledAt: "2026-01-05T09:05:00.000Z" });
    a.setPair({ a: "slack:C0OPS:m5", b: "slack:C0OPS:m6", verdict: "same", labeledAt: "2026-01-05T09:04:00.000Z" });
    expect(loadLabels(root).pairs).toEqual([expect.objectContaining({ verdict: "different" })]);
  });

  it("toggles a not-work mark from the file as it is now, not a stale view", () => {
    const a = new LabelSession(root);
    const b = new LabelSession(root);
    expect(a.toggleNotWork("slack:C0OPS:m7")).toBe(true);
    // b hasn't seen a's mark: its toggle clears it rather than marking again
    expect(b.toggleNotWork("slack:C0OPS:m7")).toBe(false);
    expect(loadLabels(root).notWork).toEqual([]);
    // a's later save doesn't bring its mark back
    a.setPair({ a: "slack:C0OPS:m8", b: "slack:C0OPS:m9", verdict: "same", labeledAt: new Date().toISOString() });
    expect(loadLabels(root).notWork).toEqual([]);
  });

  it("won't read labels through an eval-data directory that resolves elsewhere", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(join(elsewhere, "linking"), { recursive: true });
    writeFileSync(join(elsewhere, "linking", "labels.json"), JSON.stringify(emptyLabels()));
    symlinkSync(elsewhere, join(root, "eval-data"));
    expect(() => loadLabels(root)).toThrow(/resolves elsewhere/);
  });

  it("strips terminal escapes, bidi and zero-width characters, and puts a gutter on every body line", () => {
    expect(clean("ok\x1b[2J‮evil​﻿")).toBe("ok[2Jevil");
    expect(clean("a؜b⁠c⁤d")).toBe("abcd");
    expect(quoted("── A ── Dana in #ops\nline two")).toBe("  │ ── A ── Dana in #ops\n  │ line two");
  });

  it("won't read a symlinked labels file", () => {
    const target = join(root, "other.json");
    writeFileSync(target, JSON.stringify(emptyLabels()));
    mkdirSync(join(root, "eval-data", "linking"), { recursive: true });
    symlinkSync(target, labelsPath(root));
    expect(() => loadLabels(root)).toThrow(/symlink/);
  });

  it("keeps output directories directly under eval-data/", () => {
    expect(() => prepareOutDir(root, join("eval-data", "..", "out"))).toThrow(/outside eval-data/);
    expect(() => prepareOutDir(root, join("eval-data", "a", "b"))).toThrow(/outside eval-data/);
    expect(() => prepareOutDir(root, "linking")).toThrow(/outside eval-data/);
  });
});
