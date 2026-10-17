// tests/components/mention-input-paste.test.ts — The reply box takes pasted text as plain text, and keeps line breaks

import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createElement, createRef } from "react";
import MentionInput, { type MentionInputHandle } from "../../src/components/MentionInput.js";

afterEach(cleanup);

function renderInput() {
  const ref = createRef<MentionInputHandle>();
  const { getByRole } = render(createElement(MentionInput, {
    ref,
    placeholder: "Reply",
    mentionables: [{ id: "U0OPERATOR1", name: "Dana" }] as never,
    serializeMention: (id: string) => `<@${id}>`,
    onSubmit: () => {},
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
