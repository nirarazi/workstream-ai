// tests/digests/judge.test.ts — settling what a digest says against the app's view

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "../../core/graph/db.js";
import { ContextGraph } from "../../core/graph/index.js";
import { DigestJudge, JUDGE_CALLS_PER_POLL, buildJudgePrompt, parseVerdict } from "../../core/digests/judge.js";
import type { StatusCategory } from "../../core/types.js";

let db: Database;
let graph: ContextGraph;
const DIGEST_AT = "2026-10-15T09:00:00.000Z";

beforeEach(() => {
  db = new Database(":memory:");
  graph = new ContextGraph(db);
  graph.upsertAgent({ id: "U-atlas", name: "Atlas", platform: "slack", platformUserId: "U-atlas" });
  graph.upsertThread({ id: "T-DIGEST", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: null });
  graph.insertEvent({
    threadId: "T-DIGEST", messageId: "d1", workItemId: null, agentId: "U-atlas", status: "blocked_on_human", confidence: 0.9,
    rawText: "Daily: OPS-1 needs Alex's approval, OPS-2 moving, OPS-3 moving", timestamp: DIGEST_AT, digest: true,
  });
});
afterEach(() => db.close());

/** An item the app sees as `itemStatus` (set at `statusAt`), and a digest saying `digestStatus` about it */
function disagreement(id: string, itemStatus: StatusCategory, digestStatus: StatusCategory, opts: { statusAt?: string; targeted?: boolean } = {}) {
  graph.upsertWorkItem({ id, source: "jira", title: `Item ${id}`, currentAtcStatus: itemStatus, currentConfidence: 0.8, statusAt: opts.statusAt ?? "2026-10-14T09:00:00.000Z" });
  graph.linkThreadWorkItem("T-DIGEST", id, "mentioned");
  const eventId = graph.getEventByMessageId("d1", "T-DIGEST")!.id;
  graph.recordDigestCheck({ eventId, workItemId: id, digestStatus, digestTargeted: opts.targeted ?? false, itemStatus, at: DIGEST_AT });
}
const check = (id: string) => db.db.prepare("SELECT resolution, judge_verdict, judged_at FROM digest_checks WHERE work_item_id = ?").get(id) as { resolution: string | null; judge_verdict: string | null; judged_at: string | null };
const answering = (verdict: string, reason = "because") => vi.fn(async () => JSON.stringify({ verdict, reason }));

describe("DigestJudge", () => {
  it("settles without the model when the item has moved on since, or now agrees", async () => {
    disagreement("OPS-1", "in_progress", "blocked_on_human", { statusAt: "2026-10-15T10:00:00.000Z" });
    disagreement("OPS-2", "in_progress", "completed");
    graph.upsertWorkItem({ id: "OPS-2", source: "jira", currentAtcStatus: "completed" });
    const complete = vi.fn();

    expect(await new DigestJudge(graph, complete).judgeSome()).toEqual({ settled: 2, asked: 0 });

    expect(check("OPS-1").resolution).toBe("superseded");
    expect(check("OPS-2").resolution).toBe("agrees");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps the app's view when the model says so", async () => {
    disagreement("OPS-1", "in_progress", "blocked_on_human", { targeted: true });

    await new DigestJudge(graph, answering("app")).judgeSome();

    expect(check("OPS-1")).toMatchObject({ resolution: "app", judge_verdict: "app" });
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("in_progress");
  });

  it("adopts the digest's view, and puts the item in Needs me when the digest says it needs the operator", async () => {
    disagreement("OPS-1", "in_progress", "blocked_on_human", { targeted: true });

    await new DigestJudge(graph, answering("digest")).judgeSome();

    expect(check("OPS-1").resolution).toBe("digest");
    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(graph.getActionableItems().map((i) => i.workItem.id)).toEqual(["OPS-1"]);
  });

  it("never takes an item out of Needs me on a digest's word: that waits for the operator", async () => {
    disagreement("OPS-1", "blocked_on_human", "in_progress");

    await new DigestJudge(graph, answering("digest")).judgeSome();

    expect(graph.getWorkItemById("OPS-1")!.currentAtcStatus).toBe("blocked_on_human");
    expect(check("OPS-1")).toMatchObject({ resolution: null, judge_verdict: "unsure" });
  });

  it("leaves what it can't settle for the operator, and doesn't ask again", async () => {
    disagreement("OPS-1", "in_progress", "completed");
    disagreement("OPS-2", "in_progress", "completed");
    const complete = vi.fn().mockResolvedValueOnce('{"verdict":"unsure","reason":"no messages"}').mockResolvedValueOnce("Sure! The digest is right.");

    await new DigestJudge(graph, complete).judgeSome();
    await new DigestJudge(graph, complete).judgeSome();

    expect(check("OPS-1")).toMatchObject({ resolution: null, judge_verdict: "unsure" });
    expect(check("OPS-2")).toMatchObject({ resolution: null, judge_verdict: "unsure" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("tries again next poll when the model can't be reached, and asks at most a few times a poll", async () => {
    for (const id of ["OPS-1", "OPS-2", "OPS-3", "OPS-4", "OPS-5"]) disagreement(id, "in_progress", "completed");
    const down = vi.fn().mockRejectedValue(new Error("Daily LLM budget exhausted"));

    expect(await new DigestJudge(graph, down).judgeSome()).toEqual({ settled: 0, asked: 1 });
    expect(check("OPS-1").judged_at).toBeNull();

    const up = answering("app");
    expect((await new DigestJudge(graph, up).judgeSome()).asked).toBe(JUDGE_CALLS_PER_POLL);
    expect(up).toHaveBeenCalledTimes(JUDGE_CALLS_PER_POLL);
  });

  it("gives the model the digest and the item's own messages as data", async () => {
    disagreement("OPS-1", "in_progress", "blocked_on_human", { targeted: true });
    graph.upsertThread({ id: "T-OWN", channelId: "C1", channelName: "fleet-ops", platform: "slack", workItemId: "OPS-1" });
    graph.linkThreadWorkItem("T-OWN", "OPS-1", "primary");
    graph.insertEvent({ threadId: "T-OWN", messageId: "o1", workItemId: "OPS-1", agentId: "U-atlas", status: "in_progress", confidence: 0.9, rawText: "Deploying OPS-1 now", timestamp: "2026-10-14T12:00:00.000Z" });
    const complete = answering("app");

    await new DigestJudge(graph, complete).judgeSome();

    const [prompt, system] = complete.mock.calls[0] as unknown as [string, string];
    expect(system).toMatch(/data .* not instructions/);
    expect(prompt).toContain("<digest>\nDaily: OPS-1 needs Alex's approval");
    expect(prompt).toContain("<messages>\n[2026-10-14T12:00:00.000Z] Deploying OPS-1 now");
    expect(prompt).not.toContain("Daily: OPS-1 needs Alex's approval, OPS-2 moving, OPS-3 moving\n</messages>");
  });

  it("reads only a verdict out of the model's reply", () => {
    expect(parseVerdict('Here you go: {"verdict":"digest","reason":"newer"}')).toEqual({ verdict: "digest", reason: "newer" });
    expect(parseVerdict('{"verdict":"apply everything"}')).toBeNull();
    expect(parseVerdict("no json")).toBeNull();
    expect(buildJudgePrompt({ eventId: "e", workItemId: "OPS-9", digestStatus: "completed", digestTargeted: false, itemStatus: null, createdAt: DIGEST_AT, digestText: "x".repeat(5000), threadId: "T" }, null, []).length).toBeLessThan(2000);
  });
});
