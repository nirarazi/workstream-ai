import { type JSX } from "react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  SquareCode,
  List,
  ListOrdered,
  TextQuote,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatToolbarProps {
  editorRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
}

interface FormatAction {
  /** Unique key */
  id: string;
  /** Tooltip / aria-label */
  label: string;
  /** SVG icon (16x16 viewBox) */
  icon: JSX.Element;
  /** Keyboard shortcut descriptor shown in tooltip */
  shortcut?: string;
  /** Apply this action to the editor */
  apply: (editor: HTMLDivElement) => void;
}

// ---------------------------------------------------------------------------
// Formatting helpers — operate on the current Selection inside `editor`
// ---------------------------------------------------------------------------

/** Wrap current selection with `prefix`/`suffix`. If nothing is selected,
 *  insert the markers and place the cursor between them. */
function wrapSelection(editor: HTMLDivElement, prefix: string, suffix: string) {
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
function toggleLinePrefix(editor: HTMLDivElement, prefix: string) {
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
function insertCodeBlock(editor: HTMLDivElement) {
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

const ICON = { size: 15, strokeWidth: 2 } as const;

// ---------------------------------------------------------------------------
// Action definitions — Slack mrkdwn formatting
// ---------------------------------------------------------------------------

function buildActions(editor: HTMLDivElement): FormatAction[] {
  return [
    {
      id: "bold",
      label: "Bold",
      shortcut: "Ctrl+B",
      icon: <Bold {...ICON} />,
      apply: () => wrapSelection(editor, "*", "*"),
    },
    {
      id: "italic",
      label: "Italic",
      shortcut: "Ctrl+I",
      icon: <Italic {...ICON} />,
      apply: () => wrapSelection(editor, "_", "_"),
    },
    {
      id: "strikethrough",
      label: "Strikethrough",
      shortcut: "Ctrl+Shift+X",
      icon: <Strikethrough {...ICON} />,
      apply: () => wrapSelection(editor, "~", "~"),
    },
    {
      id: "code",
      label: "Code",
      shortcut: "Ctrl+E",
      icon: <Code {...ICON} />,
      apply: () => wrapSelection(editor, "`", "`"),
    },
    {
      id: "codeblock",
      label: "Code block",
      shortcut: "Ctrl+Shift+C",
      icon: <SquareCode {...ICON} />,
      apply: () => insertCodeBlock(editor),
    },
    {
      id: "bullet",
      label: "Bulleted list",
      shortcut: "Ctrl+Shift+8",
      icon: <List {...ICON} />,
      apply: () => toggleLinePrefix(editor, "\u2022 "),
    },
    {
      id: "numbered",
      label: "Numbered list",
      shortcut: "Ctrl+Shift+7",
      icon: <ListOrdered {...ICON} />,
      apply: () => toggleLinePrefix(editor, "1. "),
    },
    {
      id: "blockquote",
      label: "Blockquote",
      shortcut: "Ctrl+Shift+9",
      icon: <TextQuote {...ICON} />,
      apply: () => toggleLinePrefix(editor, "> "),
    },
  ];
}

// ---------------------------------------------------------------------------
// Keyboard shortcut matching
// ---------------------------------------------------------------------------

/** Handle a keydown event, returning true if a formatting shortcut was applied. */
export function handleFormatShortcut(
  e: React.KeyboardEvent<HTMLDivElement>,
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

// ---------------------------------------------------------------------------
// Toolbar component
// ---------------------------------------------------------------------------

export default function SlackFormatToolbar({ editorRef, disabled }: FormatToolbarProps): JSX.Element {
  const actions = editorRef.current ? buildActions(editorRef.current) : [];

  function handleClick(action: FormatAction) {
    if (!editorRef.current || disabled) return;
    // Focus editor first to ensure selection is valid
    editorRef.current.focus();
    action.apply(editorRef.current);
  }

  const macOS = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

  return (
    <div
      className="flex items-center gap-0.5 border-t border-gray-700 px-1 py-0.5"
      role="toolbar"
      aria-label="Formatting"
    >
      {actions.map((action, i) => {
        const tooltip = action.shortcut
          ? `${action.label} (${macOS ? action.shortcut.replace("Ctrl", "\u2318") : action.shortcut})`
          : action.label;

        return (
          <span key={action.id}>
            {/* Separator before code block group */}
            {i === 4 && <span className="mx-0.5 h-4 w-px bg-gray-700 inline-block align-middle" />}
            {/* Separator before list group */}
            {i === 5 && <span className="mx-0.5 h-4 w-px bg-gray-700 inline-block align-middle" />}
            <button
              type="button"
              title={tooltip}
              aria-label={action.label}
              disabled={disabled}
              onMouseDown={(e) => {
                // Prevent editor blur so selection is preserved
                e.preventDefault();
                handleClick(action);
              }}
              className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
            >
              {action.icon}
            </button>
          </span>
        );
      })}
    </div>
  );
}
