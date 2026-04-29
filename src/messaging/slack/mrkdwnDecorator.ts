/**
 * Live mrkdwn decorator for Slack-flavored contentEditable editors.
 *
 * Scans text nodes for completed mrkdwn patterns (*bold*, _italic_, ~strike~,
 * `code`) and wraps them in styled spans. Markers are hidden but kept in the
 * DOM so serialization is unaffected.
 */

interface Pattern {
  re: RegExp;
  wrapClass: string;
}

const PATTERNS: Pattern[] = [
  { re: /\*([^*\n]+)\*/g, wrapClass: "font-semibold text-gray-100" },
  { re: /_([^_\n]+)_/g, wrapClass: "italic text-gray-100" },
  { re: /~([^~\n]+)~/g, wrapClass: "line-through text-gray-100" },
  { re: /`([^`\n]+)`/g, wrapClass: "font-mono text-gray-200 bg-gray-700 rounded-sm px-1 py-px" },
];

/** Make a marker span invisible but keep it in the DOM for serialization. */
function hideMarker(span: HTMLSpanElement): void {
  span.style.cssText = "font-size:0;display:inline-block;width:0;overflow:hidden";
}

// ---------------------------------------------------------------------------
// Cursor helpers — save/restore as character offset from editor start
// ---------------------------------------------------------------------------

function getCursorOffset(editor: HTMLDivElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(editor);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCursorOffset(editor: HTMLDivElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let n = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.textContent?.length ?? 0;
    if (n + len >= offset) {
      const r = document.createRange();
      r.setStart(node, offset - n);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    n += len;
  }
}

// ---------------------------------------------------------------------------
// Strip existing decorations — replace spans with plain text
// ---------------------------------------------------------------------------

function stripDecorations(editor: HTMLDivElement): void {
  const decorated = editor.querySelectorAll("[data-mrkdwn]");
  for (const el of decorated) {
    const text = document.createTextNode(el.textContent ?? "");
    el.parentNode!.replaceChild(text, el);
  }
  editor.normalize();
}

// ---------------------------------------------------------------------------
// Apply decorations to text nodes
// ---------------------------------------------------------------------------

type Hit = { s: number; e: number; marker: string; inner: string; cls: string };

function applyDecorations(editor: HTMLDivElement): void {
  // Collect text nodes, skip mention pills
  const nodes: Text[] = [];
  const tw = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-mention-id]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  while (tw.nextNode()) nodes.push(tw.currentNode as Text);

  for (const textNode of nodes) {
    const text = textNode.textContent ?? "";
    if (!text) continue;

    // Gather all matches across patterns
    const hits: Hit[] = [];
    for (const { re, wrapClass } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        hits.push({
          s: m.index,
          e: m.index + m[0].length,
          marker: m[0][0],
          inner: m[1],
          cls: wrapClass,
        });
      }
    }
    if (hits.length === 0) continue;

    // Sort by position, drop overlapping
    hits.sort((a, b) => a.s - b.s);
    const kept: Hit[] = [];
    let end = 0;
    for (const h of hits) {
      if (h.s >= end) {
        kept.push(h);
        end = h.e;
      }
    }

    // Build replacement fragment
    const frag = document.createDocumentFragment();
    let pos = 0;

    for (const h of kept) {
      // Plain text before this match
      if (h.s > pos) frag.appendChild(document.createTextNode(text.slice(pos, h.s)));

      // Decorated wrapper
      const wrap = document.createElement("span");
      wrap.dataset.mrkdwn = h.marker;
      wrap.className = h.cls;

      // Opening marker (hidden but in DOM for serialization)
      const open = document.createElement("span");
      open.textContent = h.marker;
      hideMarker(open);
      wrap.appendChild(open);

      // Inner content
      wrap.appendChild(document.createTextNode(h.inner));

      // Closing marker (hidden)
      const close = document.createElement("span");
      close.textContent = h.marker;
      hideMarker(close);
      wrap.appendChild(close);

      frag.appendChild(wrap);
      pos = h.e;
    }

    // Remaining text
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));

    textNode.parentNode!.replaceChild(frag, textNode);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Decorate editor content with live mrkdwn formatting preview. */
export function decorateSlackMrkdwn(editor: HTMLDivElement): void {
  const offset = getCursorOffset(editor);
  stripDecorations(editor);
  applyDecorations(editor);
  if (offset !== null) setCursorOffset(editor, offset);
}
