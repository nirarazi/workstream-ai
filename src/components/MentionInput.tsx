import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, type JSX } from "react";
import type { Mentionable } from "../lib/api";
import MentionDropdown from "./MentionDropdown";
import { filterMentionables } from "../lib/mentions";

export interface MentionInputHandle {
  /** Serialize the current editor content (mentions → platform tokens) */
  serialize: () => string;
  /** Clear the editor */
  clear: () => void;
}

interface MentionInputProps {
  placeholder?: string;
  disabled?: boolean;
  mentionables: Mentionable[];
  /** Convert a user ID to the platform's wire format (e.g. Slack → "<@USERID>") */
  serializeMention: (userId: string) => string;
  onSubmit: (serializedText: string) => void;
  /** When set, populates the editor with this text and focuses it. Increment the key to re-trigger. */
  prefill?: { text: string; key: number };
  /** Optional platform-specific formatting toolbar rendered below the input */
  FormatToolbar?: React.ComponentType<{ editorRef: React.RefObject<HTMLDivElement | null>; disabled?: boolean }>;
  /** Optional platform-specific keyboard shortcut handler for formatting */
  onFormatShortcut?: (e: React.KeyboardEvent<HTMLDivElement>, editor: HTMLDivElement) => boolean;
  /** Optional live input decorator for formatting preview (e.g., mrkdwn highlighting) */
  decorateInput?: (editor: HTMLDivElement) => void;
}

// Unicode zero-width space — used as a cursor landing pad after mention pills
const ZWS = "\u200B";

/**
 * Characters that don't show but can change what's sent, dropped from text that comes from elsewhere (pastes, drops,
 * prefilled replies): zero-width and filler characters, reordering controls (bidirectional embeddings, overrides and
 * isolates), the byte order mark, variation selectors other than emoji presentation, and tag characters, which some
 * models read as hidden text. Kept: the joiners and direction marks that scripts and emoji need.
 */
const INVISIBLE =
  /[\u00AD\u034F\u115F\u1160\u180E\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0E\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Rich text input with @mention typeahead.
 *
 * Uses a contentEditable div internally. Mention "pills" are non-editable spans
 * with `data-mention-id`. On submit, the content is serialized: text nodes become
 * plain text, mention spans become platform-specific mention tokens.
 */
const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(function MentionInput({
  placeholder,
  disabled,
  mentionables,
  serializeMention,
  onSubmit,
  prefill,
  FormatToolbar,
  onFormatShortcut,
  decorateInput,
}, ref): JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  const insertingRef = useRef(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);

  // Prefill editor when requested
  useEffect(() => {
    if (!prefill?.text || !editorRef.current) return;
    editorRef.current.textContent = prefill.text.replace(INVISIBLE, "");
    setIsEmpty(false);
    editorRef.current.focus();
    // Move cursor to end
    const range = document.createRange();
    range.selectNodeContents(editorRef.current);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [prefill?.key]);

  // --- Serialization ---

  const serialize = useCallback((): string => {
    const el = editorRef.current;
    if (!el) return "";

    let result = "";
    let lineBreakFirst = false;
    const add = (part: string) => {
      if (lineBreakFirst && result && !result.endsWith("\n")) result += "\n";
      lineBreakFirst = false;
      result += part;
    };
    // Line breaks typed with Shift+Enter arrive as "\n", <br> or a <div> per line, and mentions can sit inside any of
    // them. Only DIV and P count as lines: nothing else that makes blocks can get in, as pastes are plain text.
    const walk = (parent: Node) => {
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent) add(node.textContent);
        } else if (node instanceof HTMLElement && node.dataset.mentionId) {
          add(serializeMention(node.dataset.mentionId));
        } else if (node instanceof HTMLBRElement) {
          add("\n");
        } else if (node instanceof HTMLElement) {
          const block = node.tagName === "DIV" || node.tagName === "P";
          if (block) lineBreakFirst = true;
          walk(node);
          if (block) lineBreakFirst = true;
        }
      }
    };
    walk(el);
    // Strip zero-width spaces from serialized output
    return result.replace(/\u200B/g, "").trim();
  }, [serializeMention]);

  // Expose serialize/clear to parent via ref
  useImperativeHandle(ref, () => ({
    serialize,
    clear() {
      if (editorRef.current) {
        editorRef.current.innerHTML = "";
        updateEmpty();
      }
    },
  }), [serialize]);

  // --- Mention insertion ---

  const insertMention = useCallback((m: Mentionable) => {
    const el = editorRef.current;
    if (!el) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    // Find and remove the @query text before the cursor
    const range = sel.getRangeAt(0);
    const textNode = range.startContainer;
    if (textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const text = textNode.textContent;
      const cursorPos = range.startOffset;
      // Walk backwards from cursor to find the @ trigger
      const beforeCursor = text.slice(0, cursorPos);
      const atIndex = beforeCursor.lastIndexOf("@");
      if (atIndex >= 0) {
        // Remove @query from text node
        const before = text.slice(0, atIndex);
        const after = text.slice(cursorPos);
        textNode.textContent = before;

        // Create mention pill
        const pill = document.createElement("span");
        pill.dataset.mentionId = m.id;
        pill.contentEditable = "false";
        pill.className =
          "inline-flex items-center rounded bg-cyan-900/50 px-1 py-0.5 text-cyan-300 text-xs font-medium mx-0.5 align-baseline";
        pill.textContent = `@${m.name}`;

        // Create text node after pill for continued typing
        const afterNode = document.createTextNode(ZWS + after);

        // Insert pill and after-text
        const parent = textNode.parentNode!;
        const nextSibling = textNode.nextSibling;
        parent.insertBefore(pill, nextSibling);
        parent.insertBefore(afterNode, pill.nextSibling);

        // Place cursor after the pill
        const newRange = document.createRange();
        newRange.setStart(afterNode, 1); // after the ZWS
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }

    setShowDropdown(false);
    setMentionQuery("");
    setSelectedIndex(0);
    updateEmpty();
    // Re-decorate after mention insertion
    if (decorateInput && el) decorateInput(el);
  }, [decorateInput]);

  // --- Input handling ---

  // Pasted or dropped content goes in as plain text without invisible characters: markup could hide text that
  // would still be posted as the operator, or load images from someone else's server
  function insertPlainText(e: React.ClipboardEvent<HTMLDivElement> | React.DragEvent<HTMLDivElement>) {
    const el = editorRef.current;
    const data = "clipboardData" in e ? e.clipboardData : e.dataTransfer;
    e.preventDefault();
    const text = data?.getData("text/plain").replace(/\r\n?/g, "\n").replace(INVISIBLE, "") ?? "";
    const sel = window.getSelection();
    if (!text || !el || !sel) return;

    let range: Range | null = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if ("dataTransfer" in e) {
      const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      range = caret ? document.createRange() : document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? range;
      if (caret && range) range.setStart(caret.offsetNode, caret.offset);
    }
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    // Never inside a mention: its text isn't what's sent
    const pill = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
      ?.closest("[data-mention-id]");
    if (pill) {
      range.setStartAfter(pill);
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);

    // Line by line through the browser's editing commands keeps undo, and the text flat (the editor keeps "\n" as
    // is) rather than a <div> per line. Where they're unavailable, insert a text node at the caret.
    const lines = text.split("\n");
    // Each command fires an input event: decorate once at the end, not once per line
    insertingRef.current = true;
    try {
      const first = lines[0] ? document.execCommand?.("insertText", false, lines[0]) : document.execCommand?.("insertLineBreak");
      if (first) {
        lines.forEach((line, i) => {
          if (i === 0) return;
          if (i > 1 || lines[0]) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
      } else {
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } finally {
      insertingRef.current = false;
    }
    handleInput();
    // Decorate even when the text ends in a mention trigger, so nothing pasted is left in a hidden marker
    decorateInput?.(el);
  }

  function updateEmpty() {
    const el = editorRef.current;
    const text = el?.textContent?.replace(/\u200B/g, "") ?? "";
    setIsEmpty(text.trim().length === 0);
  }

  function handleInput() {
    if (insertingRef.current) return;
    updateEmpty();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setShowDropdown(false);
      return;
    }

    const range = sel.getRangeAt(0);
    const textNode = range.startContainer;
    if (textNode.nodeType !== Node.TEXT_NODE || !textNode.textContent) {
      setShowDropdown(false);
      return;
    }

    const text = textNode.textContent;
    const cursorPos = range.startOffset;
    const beforeCursor = text.slice(0, cursorPos);

    // Check for @ trigger — find last @ that isn't preceded by a word char
    const match = beforeCursor.match(/(?:^|[^a-zA-Z0-9])@([a-zA-Z0-9_]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setShowDropdown(true);
      setSelectedIndex(0);
    } else {
      setShowDropdown(false);
      // Apply live formatting decoration when not in mention mode
      if (decorateInput && editorRef.current) {
        decorateInput(editorRef.current);
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Platform formatting shortcuts (Ctrl+B, Ctrl+I, etc.)
    if (onFormatShortcut && editorRef.current && onFormatShortcut(e, editorRef.current)) {
      return;
    }

    if (showDropdown) {
      const filtered = filterMentionables(mentionables, mentionQuery);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (filtered.length > 0) {
          e.preventDefault();
          insertMention(filtered[selectedIndex] ?? filtered[0]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowDropdown(false);
        return;
      }
    }

    // Submit on Enter (without shift)
    if (e.key === "Enter" && !e.shiftKey && !showDropdown) {
      e.preventDefault();
      const text = serialize();
      if (text) {
        onSubmit(text);
        // Clear editor
        if (editorRef.current) {
          editorRef.current.innerHTML = "";
          updateEmpty();
        }
      }
    }
  }

  // Handle backspace into a mention pill — delete the whole pill
  function handleBeforeInput(e: InputEvent) {
    if (e.inputType === "deleteContentBackward") {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      // If cursor is at start of a text node and previous sibling is a pill
      if (
        range.collapsed &&
        range.startOffset === 0 &&
        range.startContainer.nodeType === Node.TEXT_NODE
      ) {
        const prev = range.startContainer.previousSibling;
        if (prev instanceof HTMLElement && prev.dataset.mentionId) {
          e.preventDefault();
          prev.remove();
          updateEmpty();
        }
      }

      // If cursor is at offset 1 of a ZWS text node (right after pill)
      if (
        range.collapsed &&
        range.startOffset <= 1 &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startContainer.textContent?.startsWith(ZWS)
      ) {
        const prev = range.startContainer.previousSibling;
        if (prev instanceof HTMLElement && prev.dataset.mentionId) {
          e.preventDefault();
          prev.remove();
          // Also remove the ZWS
          const textNode = range.startContainer;
          if (textNode.textContent === ZWS) {
            textNode.textContent = "";
          } else {
            textNode.textContent = textNode.textContent!.slice(1);
          }
          updateEmpty();
        }
      }
    }
  }

  // Attach beforeinput event (React doesn't have a synthetic version for InputEvent)
  // Use a ref-based handler so we don't re-attach on every render
  const handleBeforeInputRef = useRef(handleBeforeInput);
  handleBeforeInputRef.current = handleBeforeInput;

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const handler = (e: Event) => handleBeforeInputRef.current(e as InputEvent);
    el.addEventListener("beforeinput", handler);
    return () => el.removeEventListener("beforeinput", handler);
  }, []);

  return (
    <div className="relative">
      {showDropdown && (
        <MentionDropdown
          query={mentionQuery}
          mentionables={mentionables}
          selectedIndex={selectedIndex}
          onSelect={insertMention}
        />
      )}
      <div className={`rounded border border-gray-700 bg-gray-800 focus-within:border-gray-500 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={insertPlainText}
          onDrop={insertPlainText}
          // Dragging text within the editor would copy it, as drops are taken as plain text: cut and paste instead
          onDragStart={(e) => e.preventDefault()}
          data-placeholder={placeholder}
          className={`
            min-h-[34px] w-full whitespace-pre-wrap break-words
            px-3 py-1.5 text-sm text-gray-100 outline-none
            ${isEmpty ? "before:content-[attr(data-placeholder)] before:text-gray-500 before:pointer-events-none" : ""}
          `}
          role="textbox"
          aria-label={placeholder}
        />
        {FormatToolbar && (
          <FormatToolbar editorRef={editorRef} disabled={disabled} />
        )}
      </div>
    </div>
  );
});

export default MentionInput;
