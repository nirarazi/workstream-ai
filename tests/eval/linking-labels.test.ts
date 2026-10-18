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
  toggleNotWork,
} from "../../core/eval/linking-labels.js";
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
    expect(loadLabels(root)).toEqual({ version: LABELS_VERSION, keyFormat: KEY_FORMAT, pairs: [], notWork: [] });
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
