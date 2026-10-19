// tests/adapters/slack-observe.test.ts — a Slack message as an observation

import { describe, it, expect } from "vitest";
import { observeSlackMessage, splitQuotes } from "../../core/adapters/messaging/slack/observe.js";
import type { Message } from "../../core/types.js";

const workspace = { teamId: "T0NORTHWND", url: "https://northwind.slack.com" };

function message(over: Partial<Message> = {}): Message {
  return {
    id: "1700000100.000200",
    threadId: "1700000000.000100",
    channelId: "C0OPS",
    channelName: "ops",
    userId: "U0ATLAS",
    userName: "Atlas",
    text: "Deployed OPS-101",
    timestamp: "2023-11-14T22:15:00.000Z",
    platform: "slack",
    senderType: "agent",
    ...over,
  };
}

describe("splitQuotes", () => {
  it("separates runs of quoted lines from the author's own", () => {
    expect(splitQuotes("&gt; can you ship it?\n&gt; today?\nYes, shipping now\n> one more")).toEqual({
      own: "Yes, shipping now",
      quoted: ["can you ship it?\ntoday?", "one more"],
    });
  });
});

describe("observeSlackMessage", () => {
  it("keys a reply by workspace, channel and ts, and points at its thread's root", () => {
    const o = observeSlackMessage(message(), workspace)!;
    expect(o.dedupeKey).toBe("slack:T0NORTHWND/C0OPS/1700000100.000200");
    expect(o.refs.repliesTo).toBe("slack:T0NORTHWND/C0OPS/1700000000.000100");
    expect(o).toMatchObject({ kind: "message", platform: "slack", messageId: "1700000100.000200", senderKind: "agent" });
    expect(o.container).toEqual({ kind: "channel", id: "C0OPS", name: "ops" });
    expect(o.author).toEqual({ platform: "slack", id: "U0ATLAS" });
  });

  it("gives a thread's root no reply ref", () => {
    const o = observeSlackMessage(message({ id: "1700000000.000100" }), workspace)!;
    expect(o.refs.repliesTo).toBeUndefined();
  });

  it("keys a permalink to this workspace as a quote, other links as external refs, and mentions as participants", () => {
    const text = [
      "<@U0DANA|Dana> see <https://northwind.slack.com/archives/C0SALES/p1700000050000300?thread_ts=1700000000.000100|this>",
      "and <https://forge.example/org/repo/pull/7> plus <https://contoso.slack.com/archives/C0X/p1700000050000300>",
    ].join("\n");
    const o = observeSlackMessage(message({ text }), workspace)!;
    expect(o.refs.quotes).toEqual(["slack:T0NORTHWND/C0SALES/1700000050.000300"]);
    expect(o.externalRefs.map((r) => r.value)).toEqual([
      "https://forge.example/org/repo/pull/7",
      "https://contoso.slack.com/archives/C0X/p1700000050000300",
    ]);
    expect(o.participants).toEqual([{ platform: "slack", id: "U0DANA" }]);
  });

  it("reads a long run of unclosed links quickly", () => {
    const text = "<https://x".repeat(4000) + " <@U0DANA|".repeat(4000);
    const started = Date.now();
    observeSlackMessage(message({ text }), workspace);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("can't key a message without a workspace or an id", () => {
    expect(observeSlackMessage(message(), { teamId: "", url: null })).toBeNull();
    expect(observeSlackMessage(message({ id: "" }), workspace)).toBeNull();
  });
});
