import { useState, useRef, useCallback, useEffect, type JSX } from "react";
import type { Mentionable } from "../lib/api";
import MentionDropdown, { filterMentionables } from "./MentionDropdown";

interface MentionInputProps {
  placeholder?: string;
  disabled?: boolean;
  mentionables: Mentionable[];
  /** Convert a user ID to the platform's wire format (e.g. Slack → "<@USERID>") */
  serializeMention: (userId: string) => string;
  onSubmit: (serializedText: string) => void;
  /** When set, populates the editor with this text and focuses it. Increment the key to re-trigger. */
  prefill?: { text: string; key: number };
}

// Unicode zero-width space — used as a cursor landing pad after mention pills
const ZWS = "\u200B";

/**
 * Rich text input with @mention typeahead.
 *
 * Uses a contentEditable div internally. Mention "pills" are non-editable spans
 * with `data-mention-id`. On submit, the content is serialized: text nodes become
 * plain text, mention spans become platform-specific mention tokens.
 */
export default function MentionInput({
  placeholder,
  disabled,
  mentionables,
  serializeMention,
  onSubmit,
  prefill,
}: MentionInputProps): JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);

  // Prefill editor when requested
  useEffect(() => {
    if (!prefill?.text || !editorRef.current) return;
    editorRef.current.textContent = prefill.text;
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
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent ?? "";
      } else if (node instanceof HTMLElement && node.dataset.mentionId) {
        result += serializeMention(node.dataset.mentionId);
      } else if (node instanceof HTMLElement) {
        result += node.textContent ?? "";
      }
    }
    // Strip zero-width spaces from serialized output
    return result.replace(/\u200B/g, "").trim();
  }, [serializeMention]);

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
  }, []);

  // --- Input handling ---

  function updateEmpty() {
    const el = editorRef.current;
    const text = el?.textContent?.replace(/\u200B/g, "") ?? "";
    setIsEmpty(text.trim().length === 0);
  }

  function handleInput() {
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
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
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
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        data-placeholder={placeholder}
        className={`
          min-h-[34px] w-full rounded border border-gray-700 bg-gray-800
          px-3 py-1.5 text-sm text-gray-100 outline-none
          focus:border-gray-500
          ${disabled ? "opacity-50 pointer-events-none" : ""}
          ${isEmpty ? "before:content-[attr(data-placeholder)] before:text-gray-500 before:pointer-events-none" : ""}
        `}
        role="textbox"
        aria-label={placeholder}
      />
    </div>
  );
}
