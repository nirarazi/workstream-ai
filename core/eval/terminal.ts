// core/eval/terminal.ts — Printing untrusted message text in a terminal labeler

/**
 * Slack text is untrusted: drops control characters, so a message can't send terminal escape codes, and bidi and
 * zero-width characters, so it can't reorder or hide what's shown.
 */
export function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g, "");
}

/** A message body with every line behind a gutter ("  │ "), so its lines can't pass for the labeler's own */
export function quoted(text: string): string {
  return clean(text).split("\n").map((line) => `  │ ${line}`).join("\n");
}
