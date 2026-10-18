// tests/graph/resolver.test.ts — Deterministic resolver: which work item a message belongs to

import { describe, it, expect } from "vitest";
import { DefaultExtractor } from "../../core/graph/extractors/default.js";
import {
  aboutRef,
  extractPullRequests,
  isReport,
  refsByLine,
  resolve,
  type ItemKey,
  type ResolverGraph,
  type ResolverMessage,
  type ResolverOptions,
} from "../../core/graph/resolver.js";

const extractor = new DefaultExtractor({ ticketPatterns: ["\\b([A-Z]{2,6}-\\d+)\\b"], prPatterns: [], ticketPrefixes: ["OPS-", "ENG-"] });
const options: ResolverOptions = { extractTickets: (t) => extractor.extractWorkItemIds(t) };

/** An in-memory graph: item id → keys, and message ref → item */
function fakeGraph(items: Record<string, ItemKey[]> = {}, messages: Record<string, string> = {}): ResolverGraph {
  return {
    itemForKey: (key) => Object.entries(items).find(([, keys]) => keys.includes(key))?.[0] ?? null,
    keysOf: (id) => items[id] ?? [],
    itemForMessage: (ref) => messages[ref] ?? null,
  };
}

function msg(text: string, extra: Partial<ResolverMessage> = {}): ResolverMessage {
  return { threadId: "T1", senderId: "U0ATLAS", channelId: "C0OPS", senderKind: "agent", text, status: "in_progress", priorInThread: 0, ...extra };
}

describe("resolve: rule 1, MCP", () => {
  it("uses the id an agent pushed over MCP", () => {
    const r = resolve(msg("Deployed", { mcpWorkItemId: "deploy-payments" }), fakeGraph(), options);
    expect(r).toMatchObject({ action: "create", keys: ["mcp:deploy-payments"], rule: "mcp" });
  });

  it("joins the item already holding that id, and reads a ticket key as a ticket", () => {
    const r = resolve(msg("Done", { mcpWorkItemId: "OPS-101" }), fakeGraph({ A: ["ticket:OPS-101"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", rule: "mcp" });
  });
});

describe("resolve: rule 2, thread membership", () => {
  it("joins the item its thread belongs to", () => {
    const r = resolve(msg("Still running the migration"), fakeGraph({ A: ["thread:T1"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", rule: "thread", promoted: false, addKeys: [] });
  });

  it("promotes a thread-only item to the one ticket the message is about", () => {
    const r = resolve(msg("This is OPS-101, picking it up"), fakeGraph({ A: ["thread:T1"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", addKeys: ["ticket:OPS-101"], merge: [], promoted: true });
  });

  it("merges a thread-only item into the item that already holds the ticket", () => {
    const r = resolve(msg("Done OPS-101"), fakeGraph({ A: ["thread:T1"], B: ["ticket:OPS-101", "thread:T0"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "B", merge: ["A"], promoted: true });
  });

  it("doesn't re-key an item that already has a ticket: another ticket named in its thread is a mention", () => {
    const r = resolve(msg("Blocked by ENG-202"), fakeGraph({ A: ["thread:T1", "ticket:OPS-101"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", addKeys: [], promoted: false, mentions: ["ticket:ENG-202"] });
  });

  it("a passing mention never promotes or merges a thread item", () => {
    const graph = fakeGraph({ A: ["thread:T1"], B: ["ticket:ENG-202"], C: ["ticket:OPS-99"] });
    for (const text of ["Blocked by ENG-202", "Unrelated to OPS-99, the export job is fixed", "Rolled the new keys out everywhere, which closes ENG-202"]) {
      expect(resolve(msg(text), graph, options)).toMatchObject({ action: "join", itemId: "A", promoted: false, merge: [], addKeys: [] });
    }
  });

  it("reads only the sender's own lines: a quoted ticket doesn't promote", () => {
    const r = resolve(msg("> Dana: is OPS-101 done?\nYes, shipped this morning"), fakeGraph({ A: ["thread:T1"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", promoted: false, addKeys: [] });
  });

  it("never promotes from a report posted in the thread", () => {
    const text = "Daily digest\n- OPS-101 done\n- ENG-202 blocked\n- OPS-103 in review";
    const r = resolve(msg(text), fakeGraph({ A: ["thread:T1"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "A", kind: "report", promoted: false, addKeys: [], merge: [] });
  });
});

describe("resolve: rule 3, the one ticket, PR or subject the message is about", () => {
  it("starts an item keyed by the ticket and the thread", () => {
    const r = resolve(msg("Started OPS-101: rotating the API keys"), fakeGraph(), options);
    expect(r).toMatchObject({ action: "create", keys: ["ticket:OPS-101", "thread:T1"], rule: "ref" });
  });

  it("joins the ticket's item from a new thread", () => {
    const r = resolve(msg("Done OPS-101"), fakeGraph({ B: ["ticket:OPS-101", "thread:T0"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "B", addKeys: ["thread:T1"], rule: "ref" });
  });

  it("takes the ticket the first line leads with; others are mentions, not links", () => {
    const r = resolve(msg("Done OPS-101: also unblocks ENG-202"), fakeGraph({ B: ["ticket:ENG-202"] }), options);
    expect(r).toMatchObject({ action: "create", keys: ["ticket:OPS-101", "thread:T1"], mentions: ["ticket:ENG-202"] });
  });

  it("leaves two tickets with no lead to the model", () => {
    const r = resolve(msg("Working on the export for OPS-101 and ENG-202 together", { senderKind: "human" }), fakeGraph(), options);
    expect(r).toMatchObject({ action: "undecided", ambiguous: true });
  });

  it("puts a PR named with exactly one ticket on that ticket's item", () => {
    const text = "Opened <https://forge.example/acme/api/pull/7|PR 7> for OPS-101";
    const r = resolve(msg(text), fakeGraph(), options);
    expect(r).toMatchObject({ action: "create", keys: ["ticket:OPS-101", "pr:forge.example/acme/api#7", "thread:T1"] });
  });

  it("uses a configured subject rule when no ticket is named", () => {
    const rules = { ...options, subjectRules: [{ pattern: String.raw`^\[(?<lane>[\w-]+)\]\s+(?<subject>[^(:]+)`, sender: "U0RELAY" }] };
    const text = "[intake] Contoso Ltd (renewal): sent the forms";
    expect(resolve(msg(text, { senderId: "U0RELAY" }), fakeGraph(), rules)).toMatchObject({
      action: "create",
      keys: ["subject:intake:contoso ltd", "thread:T1"],
    });
    // Scoped to its sender
    expect(resolve(msg(text, { senderId: "U0ATLAS" }), fakeGraph(), rules)).toMatchObject({ action: "undecided" });
  });
});

describe("resolve: a report's thread", () => {
  it("is never claimed by a reply: a reply about a ticket joins it without the thread", () => {
    const r = resolve(msg("Done OPS-101", { inReportThread: true }), fakeGraph({ B: ["ticket:OPS-101"] }), options);
    expect(r).toMatchObject({ action: "join", itemId: "B", addKeys: [] });
    expect(resolve(msg("Started OPS-101", { inReportThread: true }), fakeGraph(), options)).toMatchObject({
      action: "create",
      keys: ["ticket:OPS-101"],
    });
  });

  it("an ask or a person's message in it is an item of its own; an agent's other replies are activity", () => {
    const ask = resolve(msg("Which of these is first?", { inReportThread: true, status: "needs_decision", messageRef: "T1/m2" }), fakeGraph(), options);
    expect(ask).toMatchObject({ fallback: { action: "create", keys: ["message:T1/m2"] } });
    // Never lose an ask: a person's reply may be one the classifier didn't flag
    const person = resolve(msg("Can we drop the second one?", { inReportThread: true, senderKind: "human", priorInThread: 1, messageRef: "T1/m3" }), fakeGraph(), options);
    expect(person).toMatchObject({ fallback: { action: "create", keys: ["message:T1/m3"] } });
    const note = resolve(msg("Thanks, noted", { inReportThread: true, priorInThread: 1, messageRef: "T1/m4" }), fakeGraph(), options);
    expect(note).toMatchObject({ fallback: { action: "none", reason: "activity" } });
  });
});

describe("resolve: rule 4, reply and quote metadata", () => {
  it("joins the item of the message it replies to", () => {
    const r = resolve(msg("Approved, go ahead", { senderKind: "human", refersTo: ["T0/m1"] }), fakeGraph({ B: ["thread:T0"] }, { "T0/m1": "B" }), options);
    expect(r).toMatchObject({ action: "join", itemId: "B", rule: "reply", addKeys: ["thread:T1"] });
  });
});

describe("resolve: rule 6, new item or activity", () => {
  it("a lone agent progress note with no key is activity, not an item", () => {
    const r = resolve(msg("Finished the nightly cleanup", { status: "completed" }), fakeGraph(), options);
    expect(r).toMatchObject({ action: "undecided", ambiguous: false, fallback: { action: "none", reason: "activity" } });
  });

  it("an ask starts an item keyed by its thread", () => {
    const r = resolve(msg("Need Alex Rivera to approve the vendor contract", { status: "needs_decision" }), fakeGraph(), options);
    expect(r).toMatchObject({ action: "undecided", fallback: { action: "create", keys: ["thread:T1"], rule: "new" } });
  });

  it("a person's message, or a conversation with replies, starts an item", () => {
    expect(resolve(msg("Can someone look at the export?", { senderKind: "human" }), fakeGraph(), options)).toMatchObject({
      fallback: { action: "create", keys: ["thread:T1"] },
    });
    expect(resolve(msg("Back on it", { priorInThread: 2 }), fakeGraph(), options)).toMatchObject({
      fallback: { action: "create", keys: ["thread:T1"] },
    });
  });

  it("noise belongs to nothing, and isn't left to the model", () => {
    expect(resolve(msg("ok", { status: "noise" }), fakeGraph(), options)).toMatchObject({ action: "none", reason: "noise" });
  });
});

describe("resolve: reports and notifications", () => {
  it("a report naming several tickets never creates or links items", () => {
    const text = "Queue: OPS-101 waiting on review, ENG-202 merged, OPS-103 not started";
    const r = resolve(msg(text), fakeGraph({ A: ["ticket:OPS-101"], B: ["ticket:ENG-202"] }), options);
    expect(r).toMatchObject({ action: "none", reason: "report", kind: "report" });
    expect(r.mentions).toEqual(["ticket:OPS-101", "ticket:ENG-202", "ticket:OPS-103"]);
  });

  it("a notification about a tracked ticket updates its item, but never starts one", () => {
    const notification = (text: string) => msg(text, { senderKind: "notification" });
    expect(resolve(notification("OPS-101 moved to Done"), fakeGraph({ A: ["ticket:OPS-101"] }), options)).toMatchObject({
      action: "join",
      itemId: "A",
      kind: "notification",
    });
    expect(resolve(notification("OPS-101 moved to Done"), fakeGraph(), options)).toMatchObject({
      action: "undecided",
      fallback: { action: "none", reason: "notification" },
    });
  });
});

describe("isReport", () => {
  const check = (text: string, extra: Partial<ResolverMessage> = {}, own: ItemKey[] = []) => {
    const lines = refsByLine(text, options);
    const about = aboutRef(lines);
    return isReport(msg(text, extra), lines, own, about.leads ? about.subject : null);
  };

  it("flags digests naming three or more items", () => {
    expect(check("Shipped OPS-101, OPS-102 and ENG-202 overnight")).toBe("many-refs");
  });

  it("doesn't count the thread's own item", () => {
    expect(check("OPS-101 waits on OPS-102 and ENG-202", {}, ["ticket:OPS-101"])).toBeNull();
  });

  it("flags lists whose items carry different tickets", () => {
    expect(check("Where things are:\n- OPS-101 in review\n- ENG-202 blocked")).toBe("list");
  });

  it("flags report headers and no-change ticks", () => {
    expect(check("*Night summary*\nAll quiet, three runs finished")).toBe("header");
    expect(check(":memo: Daily digest")).toBe("header");
    expect(check("Heartbeat: idle")).toBe("header");
    expect(check("Nothing has changed since the last check")).toBe("no-change");
    expect(check("Weekly sync: OPS-101 and ENG-202 moved to review")).toBe("header");
  });

  it("keeps one piece of work's news as work", () => {
    expect(check("Status: OPS-101 deployed to staging")).toBeNull();
    expect(check("Daily digest: OPS-101 is done")).toBeNull();
    expect(check("Update: the export job is fixed")).toBeNull();
    expect(check("Done OPS-101: also unblocks ENG-202")).toBeNull();
  });

  it("needs a qualifier or several items for summary, recap, standup and update headers", () => {
    expect(check("## Summary\nFixed the flaky export test and reran the suite")).toBeNull();
    expect(check("**Summary** the cache fix is deployed")).toBeNull();
    expect(check("Morning update: the export job is fixed")).toBeNull();
    expect(check("Weekly sync notes")).toBeNull();
  });

  it("doesn't count a ticket's PRs, or the ticket a list is about, as other items", () => {
    const prs = "OPS-101 done: <https://forge.example/acme/api/pull/7|api#7> and <https://forge.example/acme/web/pull/9|web#9>";
    expect(check(prs)).toBeNull();
    const list = "Done OPS-101:\n- merged <https://forge.example/acme/api/pull/7|PR 7>\n- deployed OPS-101 to staging";
    expect(check(list)).toBeNull();
  });

  it("a no-change tick is only a short message saying just that", () => {
    expect(check("Idle since 09:00")).toBe("no-change");
    expect(check("No updates.")).toBe("no-change");
    const news: Array<[string, Partial<ResolverMessage>]> = [
      ["Nothing changed on our side, but the payments API now returns 500s. Need you to rotate the key.", { status: "blocked_on_human" }],
      ["Nothing changed on our side, but the payments API now returns 500s. Need you to rotate the key.", { status: "in_progress" }],
      ["OPS-101: no changes since the last review, still waiting on Dana's approval", { status: "needs_decision" }],
      ["Still idle: no tasks assigned. What should I pick up next?", { status: "in_progress" }],
      ["Idle since 09:00 because the CI runner is down", { status: "in_progress" }],
      ["Deploy failed even though nothing changed in the config", { status: "in_progress" }],
      ["No update since the vendor replied on Monday, should I escalate?", { status: "in_progress" }],
      ["Fixed OPS-101. Verified nothing changed in the public API.", { status: "completed" }],
      ["Nothing has changed since the last check\nbut the queue is growing\nand the runner is slow", { status: "in_progress" }],
    ];
    for (const [text, extra] of news) expect(check(text, extra), text).toBeNull();
  });

  it("a no-change line on a ticket still joins that ticket", () => {
    const r = resolve(
      msg("OPS-101: no changes since the last review, still waiting on Dana's approval", { status: "needs_decision" }),
      fakeGraph({ B: ["ticket:OPS-101"] }),
      options,
    );
    expect(r).toMatchObject({ action: "join", itemId: "B", kind: "work" });
  });

  it("a weak header needs its qualifier, has to end there, and never covers a blocker", () => {
    expect(check("Plan: finish OPS-101, then OPS-102")).toBeNull();
    expect(check("Update on OPS-101 and ENG-202: both merged")).toBeNull();
    expect(check("Bug report: OPS-101 and OPS-102 crash on start", { status: "blocked_on_human" })).toBeNull();
    expect(check("Bug report: OPS-101 and OPS-102 crash on start")).toBeNull();
    expect(check("Sprint plan: OPS-101 then OPS-102")).toBe("header");
    expect(check("Weekly sync: OPS-101 and ENG-202 moved to review", { status: "blocked_on_human" })).toBeNull();
  });

  it("never flags a person's message", () => {
    expect(check("Daily digest\n- OPS-101\n- ENG-202\n- OPS-103", { senderKind: "human" })).toBeNull();
  });

  it("trusts an upstream digest flag", () => {
    expect(check("All good", { digest: true })).toBe("digest-flag");
  });
});

describe("aboutRef", () => {
  const about = (text: string) => aboutRef(refsByLine(text, options));

  it("finds keys as whole keys: OPS-10 isn't inside OPS-101", () => {
    // OPS-101 leads; OPS-10 comes later. A substring search found OPS-10 at OPS-101's position and called it the lead.
    expect(about("Done OPS-101: then OPS-10 is next")).toMatchObject({ subject: "ticket:OPS-101", leads: true });
    expect(about("Shipping OPS-101 with OPS-10")).toMatchObject({ subject: "ticket:OPS-101", leads: true });
  });

  it("leads from the first own line with refs, skipping headers and lines of asides only", () => {
    expect(about("## Done\nOPS-101: rotated the keys, ENG-202 next")).toMatchObject({ subject: "ticket:OPS-101", leads: true });
    expect(about("Blocked by ENG-202 earlier.\nOPS-101: now rotated, see ENG-202")).toMatchObject({ subject: "ticket:OPS-101", leads: true });
  });

  it("never takes a dependency or an aside as the subject", () => {
    expect(about("Blocked by ENG-202")).toMatchObject({ subject: null, ambiguous: false });
    expect(about("Unrelated to OPS-99, the export job is fixed")).toMatchObject({ subject: null });
    expect(about("Still waiting on OPS-101 and duplicate of ENG-202")).toMatchObject({ subject: null });
  });

  it("a single ticket that doesn't lead is still the subject, but can't promote", () => {
    expect(about("Rolled the new keys out everywhere, which closes OPS-101")).toMatchObject({ subject: "ticket:OPS-101", leads: false });
  });

  it("pairs a ticket and a PR only on the same line", () => {
    expect(about("OPS-101: <https://forge.example/acme/api/pull/7|PR 7>")).toMatchObject({ subject: "ticket:OPS-101", extra: ["pr:forge.example/acme/api#7"] });
    expect(about("OPS-101 is done\n<https://forge.example/acme/api/pull/7|PR 7> merged")).toMatchObject({ subject: "ticket:OPS-101", extra: [] });
  });
});

describe("bounded work on long lines", () => {
  it("resolves a 40k-character line quickly", () => {
    const long = [
      ":a:".repeat(13_000) + "x",
      "https://forge.example/" + "a/".repeat(20_000),
      "*".repeat(40_000),
      "OPS-1 and ".repeat(4_000),
      ("Blocked by " + " ".repeat(30)).repeat(1_000) + "OPS-101",
    ];
    const started = performance.now();
    for (const text of long) resolve(msg(text), fakeGraph(), options);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("extractPullRequests", () => {
  it("canonicalises forge PR and MR URLs", () => {
    expect(extractPullRequests("see <https://Forge.example/Acme/api/pull/7|#7>")).toEqual(["forge.example/acme/api#7"]);
    expect(extractPullRequests("https://git.example/group/sub/repo/-/merge_requests/12")).toEqual(["git.example/group/sub/repo#12"]);
    expect(extractPullRequests("PR #7 and #8")).toEqual([]);
  });
});
