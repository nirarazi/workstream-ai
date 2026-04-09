import type { JSX } from "react";
import type { Thread } from "../lib/api";
import { openExternalUrl } from "../lib/api";
import { buildThreadUrl } from "./registry";

interface ChannelLabelProps {
  thread: Thread;
  platformMeta?: Record<string, unknown>;
}

export default function ChannelLabel({ thread, platformMeta }: ChannelLabelProps): JSX.Element {
  const url = buildThreadUrl(thread, platformMeta);
  const isPrivate = (thread.platformMeta as Record<string, unknown> | undefined)?.isPrivate;
  const icon = isPrivate ? "\uD83D\uDD12\u2009" : "#";

  if (url) {
    return (
      <button
        type="button"
        onClick={() => openExternalUrl(url)}
        className="text-xs text-gray-400 hover:text-cyan-400 hover:underline cursor-pointer"
      >
        {icon}{thread.channelName}
      </button>
    );
  }

  return (
    <span className="text-xs text-gray-500">
      {icon}{thread.channelName}
    </span>
  );
}
