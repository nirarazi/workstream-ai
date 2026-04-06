/**
 * Frontend platform registry — dispatches platform-specific rendering,
 * URL building, and mention serialization without hardcoding platform
 * names in consumer components.
 *
 * New platforms: add an entry to PLATFORMS and create the corresponding
 * module under src/platforms/<name>/.
 */

import type { Thread } from "../lib/api";
import type { JSX } from "react";

// --- Platform-specific module imports ---

import { buildSlackThreadUrl } from "./slack/urls";
import { slackSerializeMention } from "./slack/mentions";
import SlackMessage from "./slack/SlackMessage";

interface PlatformModule {
  buildThreadUrl: (thread: Thread, meta?: Record<string, unknown>) => string | null;
  serializeMention: (userId: string) => string;
  MessageRenderer: (props: { text: string; userMap?: Map<string, string> }) => JSX.Element;
}

const PLATFORMS: Record<string, PlatformModule> = {
  slack: {
    buildThreadUrl: (thread, meta) => {
      const workspaceUrl = meta?.slackWorkspaceUrl as string | undefined;
      if (workspaceUrl && thread.channelId) {
        return buildSlackThreadUrl(workspaceUrl, thread.channelId, thread.id);
      }
      return null;
    },
    serializeMention: slackSerializeMention,
    MessageRenderer: SlackMessage,
  },
};

// --- Public API ---

/** Build a thread URL for the given platform, or null if not supported */
export function buildThreadUrl(thread: Thread, platformMeta?: Record<string, unknown>): string | null {
  const mod = PLATFORMS[thread.platform];
  return mod?.buildThreadUrl(thread, platformMeta) ?? null;
}

/** Get the mention serializer for a platform, with a fallback */
export function getSerializeMention(platform: string): (userId: string) => string {
  return PLATFORMS[platform]?.serializeMention ?? ((id: string) => `@${id}`);
}

/** Render a message using the platform-specific renderer, with plain text fallback */
export function PlatformMessage({ platform, text, userMap }: {
  platform: string;
  text: string;
  userMap?: Map<string, string>;
}): JSX.Element {
  const mod = PLATFORMS[platform];
  if (mod) {
    const { MessageRenderer } = mod;
    return <MessageRenderer text={text} userMap={userMap} />;
  }
  return <span>{text}</span>;
}
