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
import { wrapSelection, toggleLinePrefix, insertCodeBlock } from "./format-editing";

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
