// core/adapters/messaging/slack/observe.ts — A Slack message as an observation (core/observations/types.ts)
//
// Pure: everything comes from the message and the workspace. Slack escapes ">" as "&gt;", so a quoted line starts
// with "&gt;" in the text the API returns. Links come as <url> or <url|label>; a link to a message in this workspace
// (https://<workspace>.slack.com/archives/<channel>/p<ts digits>) is a quote of that message, keyed like any other.
// Forwarded messages arrive as attachments, which the adapter doesn't read yet, so `forwarded` stays empty for now.

import type { Message } from "../../../types.js";
import type { ObservationDraft } from "../../../observations/types.js";

export interface SlackWorkspace {
  /** The team id auth.test returns (T…): part of every dedupeKey, so keys from two workspaces never collide */
  teamId: string;
  /** e.g. "https://northwind.slack.com" */
  url: string | null;
}

export function slackDedupeKey(teamId: string, channelId: string, ts: string): string {
  return `slack:${teamId}/${channelId}/${ts}`;
}

const QUOTE_LINE = /^\s*(?:&gt;|>)\s?/;
// No "<" inside, so an unclosed "<https://…" can't make a later match backtrack over the rest of the text
const LINK = /<(https?:\/\/[^<>|\s]+)(?:\|[^<>]*)?>/g;
const MENTION = /<@([A-Z0-9]+)(?:\|[^<>]*)?>/g;
const PERMALINK = /^https?:\/\/([^/]+)\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:[?#].*)?$/;

/** Splits quoted lines (a run of "> …" lines is one quote) from the author's own */
export function splitQuotes(text: string): { own: string; quoted: string[] } {
  const own: string[] = [];
  const quoted: string[] = [];
  let run: string[] | null = null;
  for (const line of text.split("\n")) {
    if (QUOTE_LINE.test(line)) {
      (run ??= []).push(line.replace(QUOTE_LINE, ""));
      continue;
    }
    if (run) quoted.push(run.join("\n"));
    run = null;
    own.push(line);
  }
  if (run) quoted.push(run.join("\n"));
  return { own: own.join("\n").trim(), quoted };
}

export function observeSlackMessage(message: Message, workspace: SlackWorkspace): ObservationDraft | null {
  if (!message.id || !message.channelId || !workspace.teamId) return null;
  const key = (channelId: string, ts: string) => slackDedupeKey(workspace.teamId, channelId, ts);
  const host = workspace.url ? new URL(workspace.url).host.toLowerCase() : null;

  const { own, quoted } = splitQuotes(message.text);
  const quotes: string[] = [];
  const externalRefs: ObservationDraft["externalRefs"] = [];
  for (const [, url] of message.text.matchAll(LINK)) {
    const permalink = PERMALINK.exec(url);
    if (permalink && host && permalink[1].toLowerCase() === host) {
      const quotedKey = key(permalink[2], `${permalink[3]}.${permalink[4]}`);
      if (!quotes.includes(quotedKey)) quotes.push(quotedKey);
    } else if (!externalRefs.some((r) => r.value === url)) {
      externalRefs.push({ kind: "url", value: url, url });
    }
  }
  const participants = [...new Set([...message.text.matchAll(MENTION)].map((m) => m[1]))]
    .map((id) => ({ platform: "slack", id }));

  return {
    dedupeKey: key(message.channelId, message.id),
    kind: "message",
    platform: "slack",
    occurredAt: message.timestamp,
    container: { kind: "channel", id: message.channelId, name: message.channelName || undefined },
    messageId: message.id,
    author: { platform: "slack", id: message.userId },
    participants,
    senderKind: message.senderType ?? "unknown",
    parts: { own, quoted: quoted.map((text) => ({ text })), forwarded: [] },
    refs: {
      repliesTo: message.threadId && message.threadId !== message.id ? key(message.channelId, message.threadId) : undefined,
      quotes,
      forwards: [],
    },
    externalRefs,
  };
}
