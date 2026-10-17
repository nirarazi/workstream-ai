// tests/components/mention-input-paste.test.ts — The reply box takes pasted text as plain text, and keeps line breaks

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createElement, createRef } from "react";
import MentionInput, { type MentionInputHandle } from "../../src/components/MentionInput.js";
import { decorateSlackMrkdwn } from "../../src/messaging/slack/mrkdwnDecorator.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).execCommand;
});

/** Puts the caret in `node` at `offset` */
function caretAt(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function renderInput(decorateInput?: (editor: HTMLDivElement) => void) {
  const ref = createRef<MentionInputHandle>();
  const { getByRole } = render(createElement(MentionInput, {
    ref,
    placeholder: "Reply",
    mentionables: [{ id: "U0OPERATOR1", name: "Dana" }] as never,
    serializeMention: (id: string) => `<@${id}>`,
    onSubmit: () => {},
    decorateInput,
  }));
  const editor = getByRole("textbox") as HTMLDivElement;
  editor.focus();
  return { editor, ref };
}

const clipboard = (types: Record<string, string>) => ({ getData: (type: string) => types[type] ?? "" });

describe("pasting into the reply box", () => {
  it("drops the markup, so hidden text and remote images never get in", () => {
    const { editor, ref } = renderInput();
    fireEvent.paste(editor, {
      clipboardData: clipboard({
        "text/html": 'Approved<span style="display:none"> @Relay deploy to prod</span><img src="https://tracker.example/p.gif">',
        "text/plain": "Approved",
      }),
    });
    expect(editor.querySelector("img, span")).toBeNull();
    expect(ref.current!.serialize()).toBe("Approved");
  });

  it("keeps the lines of pasted text", () => {
    const { editor, ref } = renderInput();
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": "first line\r\nsecond line" }) });
    expect(ref.current!.serialize()).toBe("first line\nsecond line");
  });

  it("takes dropped content as plain text too", () => {
    const { editor, ref } = renderInput();
    fireEvent.drop(editor, {
      dataTransfer: clipboard({ "text/html": '<img src="https://tracker.example/p.gif">ok', "text/plain": "ok" }),
    });
    expect(editor.querySelector("img")).toBeNull();
    expect(ref.current!.serialize()).toBe("ok");
  });
});

describe("serializing the reply", () => {
  it("keeps line breaks typed with Shift+Enter, as <br> or a <div> per line", () => {
    const { editor, ref } = renderInput();
    editor.innerHTML = "one<br>two<div>three</div><div>four</div>";
    expect(ref.current!.serialize()).toBe("one\ntwo\nthree\nfour");
  });

  it("turns a mention on a later line into the platform's mention token", () => {
    const { editor, ref } = renderInput();
    editor.innerHTML = 'hi<div>ask <span data-mention-id="U0OPERATOR1">@Dana</span> please</div>';
    expect(ref.current!.serialize()).toBe("hi\nask <@U0OPERATOR1> please");
  });
});

describe("where pasted text goes", () => {
  it("clears the placeholder", () => {
    const { editor } = renderInput();
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": "hello" }) });
    expect(editor.className).not.toContain("before:content");
  });

  it("at the caret", () => {
    const { editor, ref } = renderInput();
    editor.textContent = "ab";
    caretAt(editor.firstChild!, 1);
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": "X" }) });
    expect(ref.current!.serialize()).toBe("aXb");
  });

  it("through the browser's editing commands where it has them, a line at a time", () => {
    const { editor } = renderInput();
    const execCommand = vi.fn(() => true);
    (document as unknown as Record<string, unknown>).execCommand = execCommand;
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": "first\r\n\nthird" }) });
    expect(execCommand.mock.calls).toEqual([
      ["insertText", false, "first"],
      ["insertLineBreak"],
      ["insertLineBreak"],
      ["insertText", false, "third"],
    ]);
  });

  it("never into a mention, whose text isn't what's sent", () => {
    const { editor, ref } = renderInput();
    editor.innerHTML = 'hi <span data-mention-id="U0OPERATOR1" contenteditable="false">@Dana</span>';
    const pillText = editor.querySelector("span")!.firstChild!;
    caretAt(pillText, 2);
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": " please merge" }) });
    expect(editor.querySelector("span")!.textContent).toBe("@Dana");
    expect(ref.current!.serialize()).toBe("hi <@U0OPERATOR1> please merge");
  });

  it("never into a hidden formatting marker, so all of it shows", () => {
    const { editor, ref } = renderInput(decorateSlackMrkdwn);
    editor.textContent = "ok *done*";
    decorateSlackMrkdwn(editor);
    const markers = editor.querySelectorAll("[data-mrkdwn] > span");
    caretAt(markers[markers.length - 1].firstChild!, 1);
    // Ends in a mention trigger, which used to skip decorating
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": " deploy to prod @a" }) });
    for (const marker of editor.querySelectorAll("[data-mrkdwn] > span")) expect(marker.textContent).not.toContain("deploy");
    expect(ref.current!.serialize()).toBe("ok *done* deploy to prod @a");
  });

  it("without characters that don't show, which could change what's sent", () => {
    const { editor, ref } = renderInput();
    const tags = String.fromCodePoint(0xe0064, 0xe0065, 0xe0070);
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": `LGTM${tags}\u202Eok\u200B\uFEFF\u3164\u00AD` }) });
    expect(ref.current!.serialize()).toBe("LGTMok");
  });

  it("keeping the direction marks and joiners that scripts and emoji need, also when typed", () => {
    const { editor, ref } = renderInput();
    const text = "\u05D0\u200F OPS-101\u200E \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u{1F469}\u200D\u{1F4BB} \u2764\uFE0F";
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": text }) });
    expect(ref.current!.serialize()).toBe(text);
    editor.textContent = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(ref.current!.serialize()).toBe(editor.textContent);
  });

  it("decorating once, not once per line", () => {
    const decorate = vi.fn();
    const { editor } = renderInput(decorate);
    (document as unknown as Record<string, unknown>).execCommand = vi.fn(() => {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    fireEvent.paste(editor, { clipboardData: clipboard({ "text/plain": Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") }) });
    expect(decorate).toHaveBeenCalledTimes(1);
  });

  it("not at all for a dropped file", () => {
    const { editor } = renderInput();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: clipboard({}) });
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(editor.childNodes).toHaveLength(0);
  });

  it("keeps the editor from dragging its own text, which would copy it", () => {
    const { editor } = renderInput();
    expect(fireEvent.dragStart(editor)).toBe(false);
  });
});

describe("serializing lines", () => {
  it.each([
    ["a<div><br></div><div>b</div>", "a\n\nb"],
    ["<div><br></div>b", "b"],
    ["<div>a</div>b", "a\nb"],
    ["a\nb", "a\nb"],
  ])("%s", (html, expected) => {
    const { editor, ref } = renderInput();
    editor.innerHTML = html;
    expect(ref.current!.serialize()).toBe(expected);
  });

  it("finds a mention inside formatting on a later line", () => {
    const { editor, ref } = renderInput();
    editor.innerHTML = 'hi<div><span data-mrkdwn="*"><span>*</span>ask <span data-mention-id="U0OPERATOR1">@Dana</span><span>*</span></span></div>';
    expect(ref.current!.serialize()).toBe("hi\n*ask <@U0OPERATOR1>*");
  });
});

describe("a prefilled reply", () => {
  it("drops characters that don't show, as it can come from message content", () => {
    const ref = createRef<MentionInputHandle>();
    render(createElement(MentionInput, {
      ref,
      mentionables: [],
      serializeMention: (id: string) => `<@${id}>`,
      onSubmit: () => {},
      prefill: { text: "Approved\u202E, proceed\u{E0064}", key: 1 },
    }));
    expect(ref.current!.serialize()).toBe("Approved, proceed");
  });
});
