// core/graph/own-lines.ts — The lines of a message its sender wrote themselves

/**
 * The lines of a message its author wrote: without quoted lines ("> ...", which Slack sends as "&gt; ...") and without
 * a forwarded block and anything after it (its summary), which carry other people's words and the ticket IDs in them.
 */
export function ownLines(text: string): string {
  const own: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^(>|&gt;)\s*Forwarded from/i.test(trimmed)) break; // the forwarded block, and a summary after it
    if (trimmed.startsWith(">") || trimmed.startsWith("&gt;")) continue;
    own.push(line);
  }
  return own.join("\n");
}
