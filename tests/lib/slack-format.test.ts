// tests/lib/slack-format.test.ts — Tests for parseSlackMessage

import { describe, it, expect } from "vitest";
import { parseSlackMessage, type Segment } from "../../src/messaging/slack/format.js";

/** Helper: find the first segment matching a type */
function findSegment<T extends Segment["type"]>(
  segments: Segment[],
  type: T,
): Extract<Segment, { type: T }> | undefined {
  return segments.find((s) => s.type === type) as
    | Extract<Segment, { type: T }>
    | undefined;
}

describe("parseSlackMessage", () => {
  // -- Empty / plain text --

  it("returns empty array for empty string", () => {
    expect(parseSlackMessage("")).toEqual([]);
  });

  it("returns empty array for undefined-ish input", () => {
    // The function guards on !text, so null/undefined cast should also return []
    expect(parseSlackMessage(undefined as unknown as string)).toEqual([]);
  });

  it("returns single text segment for plain text", () => {
    const result = parseSlackMessage("Hello world");
    expect(result).toEqual([{ type: "text", value: "Hello world" }]);
  });

  // -- User mentions --

  it("parses user mention with label: <@U123|Alice>", () => {
    const result = parseSlackMessage("<@U123|Alice>");
    const mention = findSegment(result, "mention");
    expect(mention).toBeDefined();
    expect(mention!.name).toBe("Alice");
  });

  it("parses user mention without label, resolves via userMap", () => {
    const userMap = new Map([["U456", "Bob"]]);
    const result = parseSlackMessage("<@U456>", { userMap });
    const mention = findSegment(result, "mention");
    expect(mention).toBeDefined();
    expect(mention!.name).toBe("Bob");
  });

  it("parses user mention without label and no userMap — falls back to user ID", () => {
    const result = parseSlackMessage("<@U789>");
    const mention = findSegment(result, "mention");
    expect(mention).toBeDefined();
    expect(mention!.name).toBe("U789");
  });

  // -- Channel mentions --

  it("parses channel mention: <#C123|general>", () => {
    const result = parseSlackMessage("<#C123|general>");
    const ch = findSegment(result, "channel");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("general");
  });

  it("parses channel mention without label: <#C123>", () => {
    const result = parseSlackMessage("<#C123>");
    const ch = findSegment(result, "channel");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("channel");
  });

  // -- Links --

  it("parses link with label: <https://example.com|Click here>", () => {
    const result = parseSlackMessage("<https://example.com|Click here>");
    const link = findSegment(result, "link");
    expect(link).toBeDefined();
    expect(link!.url).toBe("https://example.com");
    expect(link!.label).toBe("Click here");
  });

  it("parses link without label and shortens to hostname+path", () => {
    const result = parseSlackMessage("<https://example.com/docs/page>");
    const link = findSegment(result, "link");
    expect(link).toBeDefined();
    expect(link!.url).toBe("https://example.com/docs/page");
    expect(link!.label).toBe("example.com/docs/page");
  });

  it("parses link without label — root path omits trailing slash", () => {
    const result = parseSlackMessage("<https://example.com>");
    const link = findSegment(result, "link");
    expect(link).toBeDefined();
    expect(link!.url).toBe("https://example.com");
    expect(link!.label).toBe("example.com");
  });

  // -- Emoji --

  it("parses known emoji shortcode: :rocket:", () => {
    const result = parseSlackMessage(":rocket:");
    const emoji = findSegment(result, "emoji");
    expect(emoji).toBeDefined();
    expect(emoji!.shortcode).toBe(":rocket:");
    expect(emoji!.unicode).toBe("\uD83D\uDE80");
  });

  it("parses unknown emoji shortcode with null unicode", () => {
    const result = parseSlackMessage(":custom_emoji:");
    const emoji = findSegment(result, "emoji");
    expect(emoji).toBeDefined();
    expect(emoji!.shortcode).toBe(":custom_emoji:");
    expect(emoji!.unicode).toBeNull();
  });

  // -- Formatting --

  it("parses bold: *hello*", () => {
    const result = parseSlackMessage("*hello*");
    const bold = findSegment(result, "bold");
    expect(bold).toBeDefined();
    expect(bold!.value).toBe("hello");
  });

  it("parses italic: _hello_", () => {
    const result = parseSlackMessage("_hello_");
    const italic = findSegment(result, "italic");
    expect(italic).toBeDefined();
    expect(italic!.value).toBe("hello");
  });

  it("parses inline code: `code`", () => {
    const result = parseSlackMessage("`some code`");
    const code = findSegment(result, "code");
    expect(code).toBeDefined();
    expect(code!.value).toBe("some code");
  });

  it("parses code block: ```code```", () => {
    const result = parseSlackMessage("```const x = 1;```");
    const code = findSegment(result, "code");
    expect(code).toBeDefined();
    expect(code!.value).toBe("const x = 1;");
  });

  // -- Broadcast --

  it("parses broadcast: <!here>", () => {
    const result = parseSlackMessage("<!here>");
    const bc = findSegment(result, "broadcast");
    expect(bc).toBeDefined();
    expect(bc!.name).toBe("here");
  });

  it("parses broadcast: <!channel>", () => {
    const result = parseSlackMessage("<!channel>");
    const bc = findSegment(result, "broadcast");
    expect(bc).toBeDefined();
    expect(bc!.name).toBe("channel");
  });

  // -- Mixed content --

  it("handles mixed content with mentions, links, and emoji", () => {
    const input = "Hey <@U001|Alice>, check <https://pr.dev/42|PR #42> :rocket:";
    const result = parseSlackMessage(input);

    // Should contain at least: text, mention, text, link, emoji
    const types = result.map((s) => s.type);
    expect(types).toContain("text");
    expect(types).toContain("mention");
    expect(types).toContain("link");
    expect(types).toContain("emoji");

    const mention = findSegment(result, "mention");
    expect(mention!.name).toBe("Alice");

    const link = findSegment(result, "link");
    expect(link!.url).toBe("https://pr.dev/42");
    expect(link!.label).toBe("PR #42");

    const emoji = findSegment(result, "emoji");
    expect(emoji!.shortcode).toBe(":rocket:");
  });

  // -- HTML entity decoding --

  it("decodes &amp;, &lt;, &gt; in text", () => {
    const result = parseSlackMessage("a &amp; b &lt; c &gt; d");
    // After decoding, all entities should be replaced
    const text = result.filter((s) => s.type === "text").map((s) => (s as { type: "text"; value: string }).value).join("");
    expect(text).toContain("a & b");
    expect(text).toContain("< c >");
  });
});
