// Slack mrkdwn editing helpers for the composer: kept out of SlackFormatToolbar.tsx so that file exports only
// its component (React Fast Refresh can then update it in place).

import type { KeyboardEvent } from "react";

// ---------------------------------------------------------------------------
// Formatting helpers — operate on the current Selection inside `editor`
// ---------------------------------------------------------------------------

/** Wrap current selection with `prefix`/`suffix`. If nothing is selected,
 *  insert the markers and place the cursor between them. */
export function wrapSelection(editor: HTMLDivElement, prefix: string, suffix: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  // Ensure the selection is inside the editor
  if (!editor.contains(range.commonAncestorContainer)) {
    editor.focus();
    return;
  }

  const selected = range.toString();

  // Check if already wrapped — toggle off
  if (selected.startsWith(prefix) && selected.endsWith(suffix)) {
    const unwrapped = selected.slice(prefix.length, -suffix.length || undefined);
    range.deleteContents();
    const text = document.createTextNode(unwrapped);
    range.insertNode(text);
    // Place cursor at end of unwrapped text
    const newRange = document.createRange();
    newRange.setStartAfter(text);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (selected.length > 0) {
    // Wrap selection
    range.deleteContents();
    const text = document.createTextNode(`${prefix}${selected}${suffix}`);
    range.insertNode(text);
    // Select the inner text (excluding markers)
    const newRange = document.createRange();
    newRange.setStart(text, prefix.length);
    newRange.setEnd(text, prefix.length + selected.length);
    sel.removeAllRanges();
    sel.addRange(newRange);
  } else {
    // No selection — insert markers and place cursor between
    const text = document.createTextNode(`${prefix}${suffix}`);
    range.insertNode(text);
    const newRange = document.createRange();
    newRange.setStart(text, prefix.length);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insert a block-level prefix at the beginning of the current line.
 *  If the line already has the prefix, remove it (toggle). */
export function toggleLinePrefix(editor: HTMLDivElement, prefix: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  if (!editor.contains(range.commonAncestorContainer)) {
    editor.focus();
    return;
  }

  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return;

  const text = node.textContent;
  const cursorPos = range.startOffset;

  // Find start of current line
  const lineStart = text.lastIndexOf("\n", cursorPos - 1) + 1;
  const beforeLine = text.slice(0, lineStart);
  const lineContent = text.slice(lineStart);

  if (lineContent.startsWith(prefix)) {
    // Toggle off
    node.textContent = beforeLine + lineContent.slice(prefix.length);
    const newRange = document.createRange();
    newRange.setStart(node, Math.max(cursorPos - prefix.length, lineStart));
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  } else {
    // Toggle on
    node.textContent = beforeLine + prefix + lineContent;
    const newRange = document.createRange();
    newRange.setStart(node, cursorPos + prefix.length);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insert a code block (triple backticks). If text is selected, wrap it. */
export function insertCodeBlock(editor: HTMLDivElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  if (!editor.contains(range.commonAncestorContainer)) {
    editor.focus();
    return;
  }

  const selected = range.toString();
  const block = selected.length > 0
    ? `\`\`\`\n${selected}\n\`\`\``
    : "```\n\n```";

  range.deleteContents();
  const text = document.createTextNode(block);
  range.insertNode(text);

  // Place cursor inside the block
  const newRange = document.createRange();
  const cursorOffset = selected.length > 0
    ? 4 + selected.length // after ```\n + selected
    : 4; // after ```\n
  newRange.setStart(text, cursorOffset);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Lucide icon size — consistent across all toolbar buttons
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Keyboard shortcut matching
// ---------------------------------------------------------------------------

/** Handle a keydown event, returning true if a formatting shortcut was applied. */
export function handleFormatShortcut(
  e: KeyboardEvent<HTMLDivElement>,
  editor: HTMLDivElement,
): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return false;

  const key = e.key.toLowerCase();

  if (!e.shiftKey) {
    if (key === "b") { e.preventDefault(); wrapSelection(editor, "*", "*"); return true; }
    if (key === "i") { e.preventDefault(); wrapSelection(editor, "_", "_"); return true; }
    if (key === "e") { e.preventDefault(); wrapSelection(editor, "`", "`"); return true; }
  } else {
    if (key === "x") { e.preventDefault(); wrapSelection(editor, "~", "~"); return true; }
    if (key === "c") { e.preventDefault(); insertCodeBlock(editor); return true; }
    if (key === "8") { e.preventDefault(); toggleLinePrefix(editor, "\u2022 "); return true; }
    if (key === "7") { e.preventDefault(); toggleLinePrefix(editor, "1. "); return true; }
    if (key === "9") { e.preventDefault(); toggleLinePrefix(editor, "> "); return true; }
  }

  return false;
}
